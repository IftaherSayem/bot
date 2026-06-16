// ============================================================
// OTP মনিটর - রিয়েল-টাইম SMS পোলিং ও OTP ডেলিভারি
// FIXED: Direct API (no library HTTP) + user-specific OTP routing
// v9: All-panel matching, faster polling, new OTP message format
// ============================================================

const panelManager = require('./panel-manager');
const numberManager = require('./number-manager');
const { extractOTP, extractApp } = require('../utils/otp-extractor');
const config = require('../../config');
const db = require('../../database');

class OTPMonitor {
  constructor() {
    this.botMap = new Map();
    this.isRunning = false;
    this.pollInterval = null;
    this.processedMessages = new Set();
    this.errorCount = 0;
    this.lastErrorLog = 0;
    this.isPolling = false;
    this.initializedPanels = new Set();
    this.lastPollTime = null;
  }

  registerBot(bot) {
    this.botMap.set(bot.token, bot);
  }

  start() {
    if (this.isRunning) return;
    this.isRunning = true;
    console.log(`OTP Monitor started (polling every ${config.OTP_POLL_INTERVAL}s)`);

    // Load recent OTPs from database to avoid duplicate group forwarding on restart
    try {
      // One-time migration: if sent_cache is empty, migrate from otp_logs
      const cacheCount = db.prepare('SELECT count(*) as c FROM sent_cache').get().c;
      if (cacheCount === 0) {
        const recentLogs = db.prepare('SELECT phone_number, full_message FROM otp_logs ORDER BY id DESC LIMIT 5000').all();
        const insertStmt = db.prepare('INSERT OR IGNORE INTO sent_cache (message_hash) VALUES (?)');
        db.transaction(() => {
          for (const log of recentLogs) {
            const normNum = (log.phone_number || '').replace(/[\s\-\+\(\)]/g, '');
            const cleanMsg = (log.full_message || '').replace(/\s+/g, ' ');
            const msgKey = `${normNum}-${cleanMsg.substring(0, 100)}`;
            insertStmt.run(msgKey);
          }
        })();
        console.log(`[MONITOR] Migrated ${recentLogs.length} logs to sent_cache.`);
      }

      // Load sent_cache into memory
      const cached = db.prepare('SELECT message_hash FROM sent_cache ORDER BY created_at DESC LIMIT 5000').all();
      for (const row of cached) {
        this.processedMessages.add(row.message_hash);
      }
      console.log(`[MONITOR] Loaded ${cached.length} previous OTPs from sent_cache to prevent duplicates.`);
    } catch (e) {
      console.error(`[MONITOR] Failed to load sent_cache: ${e.message}`);
    }

    // প্রথম চেক তৎক্ষণাৎ
    this._poll();

    // নিয়মিত পোলিং
    this.pollInterval = setInterval(() => {
      this._poll();
    }, config.OTP_POLL_INTERVAL * 1000);
  }

  stop() {
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
    this.isRunning = false;
    console.log('OTP Monitor stopped');
  }

  async _poll() {
    if (this.isPolling) return;
    this.isPolling = true;

    try {
      const statuses = panelManager.getStatus();
      // Only poll panels that are ENABLED. 
      // panelManager will automatically try to login if they are enabled but not logged in.
      const enabledPanels = statuses.filter(s => s.isEnabled);
      if (enabledPanels.length === 0) return;

      // সব অ্যাক্টিভ অ্যালোকেশন পাওয়া (panel_name নির্বিশেষে)
      const activeAllocations = db.prepare(`
        SELECT * FROM number_allocations
        WHERE status = 'active'
        AND otp_code IS NULL
      `).all();

      console.log(`[MONITOR] ${activeAllocations.length} active numbers, ${enabledPanels.length} enabled panels`);
      this.errorCount = 0;

      // Staggered polling (sequential with delay) to reduce CPU load
      const panelResults = [];
      for (const p of enabledPanels) {
        try {
          const msgs = await panelManager.getAllMessages(p.name);
          panelResults.push({ panelName: p.name, msgs, success: true });
        } catch (e) {
          panelResults.push({ panelName: p.name, msgs: [], success: false });
        }
        
        // 500ms delay between panels to prevent CPU spikes
        await new Promise(resolve => setTimeout(resolve, 500));
      }

      // সব মেসেজ প্রসেস করো
      for (const { panelName, msgs, success } of panelResults) {
        if (!success) continue;

        if (!msgs || msgs.length === 0) {
          continue;
        }

        console.log(`[${panelName}] ${msgs.length} messages`);

        for (const msg of msgs) {
          const normNum = (msg.phoneNumber || '').replace(/[\s\-\+\(\)]/g, '');
          const cleanMsg = (msg.message || '').replace(/\s+/g, ' ');
          const msgKey = `${normNum}-${cleanMsg.substring(0, 100)}`;

          if (this.processedMessages.has(msgKey)) continue;

          const otp = extractOTP(msg.message);

          if (otp) {
            const matchedAllocation = this._findMatchingAllocation(activeAllocations, msg);

            if (matchedAllocation) {
              console.log(`[MONITOR] OTP! Number: ${msg.phoneNumber}, OTP: ${otp}, User: ${matchedAllocation.telegram_user_id}`);

              numberManager.saveOTP(
                matchedAllocation.phone_number,
                otp,
                msg.message,
                panelName,
                matchedAllocation.app_id,
                matchedAllocation.telegram_user_id
              );

              await this._deliverOTP(
                matchedAllocation.telegram_user_id,
                matchedAllocation.phone_number,
                otp,
                matchedAllocation.app_id,
                panelName,
                matchedAllocation.bot_token,
                msg.message
              );

              // Remove from activeAllocations in this poll cycle to prevent duplicate matching
              const idx = activeAllocations.findIndex(a => a.id === matchedAllocation.id);
              if (idx !== -1) {
                activeAllocations.splice(idx, 1);
              }
            } else {
              console.log(`[MONITOR] Unmatched OTP found, forwarding to group: ${msg.phoneNumber} OTP:${otp}`);
              
              // Save to database so it isn't forwarded again on next restart
              try {
                const detectedApp = extractApp(msg.message) || 'Unknown';
                db.prepare(`
                  INSERT INTO otp_logs (phone_number, panel_name, app_id, otp_code, full_message, telegram_user_id, sent_to_user)
                  VALUES (?, ?, ?, ?, ?, ?, 0)
                `).run(msg.phoneNumber, panelName, detectedApp, otp, msg.message, null);
              } catch(e) {}

              await this._deliverOTPToGroupOnly(msg.phoneNumber, otp, msg.message);
              await new Promise(r => setTimeout(r, 500));
            }
          }

          this.processedMessages.add(msgKey);
          try {
            db.prepare('INSERT OR IGNORE INTO sent_cache (message_hash) VALUES (?)').run(msgKey);
          } catch(e) {}
        }
      }

      // processedMessages cleanup
      if (this.processedMessages.size > 2000) {
        const arr = [...this.processedMessages];
        this.processedMessages = new Set(arr.slice(-1000));
        
        // Also cleanup DB cache to prevent it from growing forever
        try {
          db.prepare(`
            DELETE FROM sent_cache 
            WHERE message_hash NOT IN (
              SELECT message_hash FROM sent_cache ORDER BY created_at DESC LIMIT 2000
            )
          `).run();
        } catch(e) {}
      }

      this.lastPollTime = new Date();

    } catch (error) {
      this.errorCount++;
      const now = Date.now();
      if (now - this.lastErrorLog > 30000) {
        console.error(`[MONITOR] Error (${this.errorCount}): ${error.message}`);
        this.lastErrorLog = now;
      }
      if (this.errorCount > 10) {
        clearInterval(this.pollInterval);
        console.log('[MONITOR] Too many errors. Pausing 30s...');
        setTimeout(() => {
          this.errorCount = 0;
          if (this.isRunning) {
            this.pollInterval = setInterval(() => this._poll(), config.OTP_POLL_INTERVAL * 1000);
          }
        }, 30000);
      }
    } finally {
      this.isPolling = false;
    }
  }

  /**
   * মেসেজ এর সাথে allocation match — panel_name ignored (cross-panel)
   */
  _findMatchingAllocation(allocations, message) {
    const msgNumber = (message.phoneNumber || '').replace(/[\s\-\+\(\)]/g, '');

    for (const alloc of allocations) {
      const allocNumber = (alloc.phone_number || '').replace(/[\s\-\+\(\)]/g, '');

      if (!msgNumber || !allocNumber) continue;

      // Exact match
      if (msgNumber === allocNumber) return alloc;

      // One contains the other
      if (msgNumber.length >= 8 && allocNumber.length >= 8) {
        if (msgNumber.endsWith(allocNumber) || allocNumber.endsWith(msgNumber)) return alloc;
        if (msgNumber.includes(allocNumber) || allocNumber.includes(msgNumber)) return alloc;
      }

      // Last 10 digits match
      if (msgNumber.length >= 10 && allocNumber.length >= 10) {
        if (msgNumber.slice(-10) === allocNumber.slice(-10)) return alloc;
      }
    }

    return null;
  }

  /**
   * OTP ইউজারকে ও গ্রুপে পাঠানো — নতুন format:
   * AppName : 🇪🇹 +251915205361
   * Code : 770926
   * + inline copy button
   */
  async _deliverOTP(userId, phoneNumber, otp, appId, panelName, botToken, fullMessage = '') {
    try {
      const bot = this.botMap.get(botToken) || Array.from(this.botMap.values())[0];
      if (!bot) return;

      const app = config.SUPPORTED_APPS.find(a => a.id === appId);
      const appName = app ? app.name : appId;

      const countryInfo = bot._getCountryInfo(phoneNumber);
      const flag = countryInfo ? countryInfo.flag : '🌐';
      const cleanNumber = '+' + phoneNumber.replace(/^\+/, '');

      // নতুন OTP message format (ইউজারকে)
      const userMessage =
        `${appName} : ${flag} ${cleanNumber}\n` +
        `Code : ${otp}`;

      const keyboard = {
        inline_keyboard: [
          [{ text: `📋 ${otp}`, copy_text: { text: otp } }]
        ]
      };

      await bot._safeSend(userId, userMessage, {
        reply_markup: keyboard
      });

      // গ্রুপেও পাঠাও
      await this._deliverOTPToGroupOnly(phoneNumber, otp, fullMessage);

      console.log(`[MONITOR] OTP delivered to user ${userId}`);
    } catch (error) {
      console.error(`[MONITOR] Failed to deliver OTP to ${userId}: ${error.message}`);
    }
  }

  /**
   * শুধু গ্রুপে OTP পাঠানো (Unmatched / Group Forwarding)
   */
  async _deliverOTPToGroupOnly(phoneNumber, otp, fullMessage = '') {
    try {
      const botsArray = Array.from(this.botMap.values());
      if (botsArray.length === 0) return;
      
      // Load-balance channel messages by picking a random bot
      const bot = botsArray[Math.floor(Math.random() * botsArray.length)];

      if (global.botDisabled) return; // Prevent sending to group if bot is disabled
      if (config.OTP_GROUP_ID) {
        const numStr = String(phoneNumber || '');
        let maskedNumber;
        if (numStr.length >= 7) {
          const start = Math.floor((numStr.length - 3) / 2);
          maskedNumber = numStr.slice(0, start) + '***' + numStr.slice(start + 3);
        } else {
          maskedNumber = numStr.slice(0, 2) + '***' + numStr.slice(-2);
        }

        const countryInfo = bot._getCountryInfo(numStr);
        const flag = countryInfo ? countryInfo.flag : '🌐';
        const countryName = countryInfo ? countryInfo.name : 'Unknown';

        const escHTML = (str) => String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

        const groupMessage = `<blockquote>MSH OTP BOT | OTP RCV</blockquote>\n` +
          `📞 <b>Number:</b> <code>${maskedNumber}</code>\n` +
          `🔑 <b>OTP Code:</b> <code>${otp}</code>\n\n` +
          `🌐 <b>Country:</b> ${flag} ${countryName}\n\n` +
          `<blockquote>${escHTML(fullMessage)}</blockquote>`;

        const groupKeyboard = {
          inline_keyboard: [
            [
              { text: 'Get Number', url: 'https://t.me/mshotpbot?start=start' },
              { text: 'OTP GC', url: config.OTP_GROUP_LINK }
            ]
          ]
        };

        await bot._safeSend(config.OTP_GROUP_ID, groupMessage, {
          parse_mode: 'HTML',
          reply_markup: groupKeyboard
        });
      }
    } catch (error) {
      console.error(`[MONITOR] Failed to deliver unmatched OTP to group: ${error.message}`);
    }
  }
}

module.exports = OTPMonitor;
