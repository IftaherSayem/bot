// ============================================================
// MAIN ENTRY POINT - অ্যাপ শুরু (FIXED v6 - DIRECT MODE)
// Bot uses raw HTTPS for ALL API calls (library HTTP bypassed)
// ============================================================

const dns = require('dns');

// METHOD 1: Global DNS order
if (dns.setDefaultResultOrder) {
  dns.setDefaultResultOrder('ipv4first');
}

// METHOD 2: Monkey-patch dns.lookup — FORCE family=4 for EVERY lookup
// This covers ALL modules (node-telegram-bot-api, node-fetch, undici, etc.)
const _origLookup = dns.lookup;
dns.lookup = function (hostname, options, callback) {
  if (typeof options === 'function') {
    callback = options;
    options = {};
  }
  if (options.family === undefined || options.family === 0) {
    options.family = 4;
  }
  return _origLookup.call(this, hostname, options, callback);
};

// METHOD 3: Monkey-patch dns.promises.lookup (async DNS lookups)
if (dns.promises && dns.promises.lookup) {
  const _origPLookup = dns.promises.lookup;
  dns.promises.lookup = function (hostname, options) {
    if (!options) options = {};
    if (options.family === undefined || options.family === 0) {
      options.family = 4;
    }
    return _origPLookup.call(this, hostname, options);
  };
}

console.log('[DNS] IPv4-only mode enabled (3 methods: order + lookup + promises)');

const OTPBot = require('./src/bot');
const OTPMonitor = require('./src/services/otp-monitor');
const config = require('./config');

async function main() {
  console.log('╔══════════════════════════════════════════╗');
  console.log('║   SMS OTP Telegram Bot - Starting...    ║');
  console.log('╚══════════════════════════════════════════╝');

  // কনফিগ ভেরিফিকেশন
  if (config.TELEGRAM_BOT_TOKEN === 'YOUR_BOT_TOKEN_HERE') {
    console.error('❌ ERROR: Telegram bot token not configured!');
    console.error('   Please set TELEGRAM_BOT_TOKEN in config.js');
    console.error('   Get your token from @BotFather on Telegram.');
    process.exit(1);
  }

  // ধাপ ১: বট ইনিশিয়ালাইজ (polling OFF)
  console.log('\n[1/4] Initializing Telegram Bots...');

  const botsConfig = (config.BOTS && config.BOTS.length > 0)
    ? config.BOTS
    : [{ token: config.TELEGRAM_BOT_TOKEN, name: 'Default Bot' }];

  const activeBots = [];

  // ধাপ ২: OTP মনিটর ইনিশিয়ালাইজ
  console.log('[2/4] Initializing OTP Monitor...');
  const monitor = new OTPMonitor();

  for (const botConf of botsConfig) {
    if (botConf.token === 'YOUR_BOT_TOKEN_HERE') continue;
    console.log(`[*] Creating Bot: ${botConf.name}...`);
    const botInstance = new OTPBot(botConf.token, botConf.name);
    botInstance.otpMonitor = monitor;
    monitor.registerBot(botInstance);
    activeBots.push(botInstance);
  }

  if (activeBots.length === 0) {
    console.error('❌ ERROR: No valid bot tokens configured!');
    process.exit(1);
  }

  // ধাপ ৩: প্যানেল লগইন
  console.log('[3/4] Logging in to SMS Panels...');
  const panelManager = require('./src/services/panel-manager');
  await panelManager.loginAll();

  // ধাপ ৪: টেলিগ্রাম বট শুরু (webhook clear → polling start)
  console.log('[4/4] Starting Telegram bots...');

  for (const botInstance of activeBots) {
    const botStarted = await botInstance.startBot();
    if (!botStarted) {
      console.error(`❌ Bot ${botInstance.token.substring(0, 10)}... শুরু করা যায়নি!`);
    }
  }

  // ==========================================
  // Pella.app / Cloud Hosting Health Check 
  // (পোর্ট চালু রাখবে যাতে সার্ভার স্লিপ না করে)
  // ==========================================
  const http = require('http');
  const port = process.env.PORT || 3000;
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('KMKI Bot is ALIVE and RUNNING!');
  });
  server.on('error', (e) => {
    if (e.code === 'EADDRINUSE') {
      console.log(`⚠️ Port ${port} is already in use, trying random port...`);
      setTimeout(() => {
        server.listen(0);
      }, 1000);
    }
  });
  server.listen(port, () => {
    console.log(`🌐 Dummy Web Server listening on port ${server.address() ? server.address().port : port} (for Health Checks)`);
  });

  // মনিটর শুরু
  monitor.start();

  console.log('\n✅ Bot is now running!');
  console.log(`📡 Polling: every 1.5s (short-poll)`);
  console.log(`📱 Supported apps: ${config.SUPPORTED_APPS.length}`);
  console.log(`🖥️ Active panels: ${config.PANELS.filter(p => p.enabled).length}`);
  console.log('\nPress Ctrl+C to stop.');

  // বট স্টার্ট হলে গ্রুপে মেসেজ পাঠানো
  if (config.OTP_GROUP_ID && activeBots.length > 0) {
    try {
      await activeBots[0]._safeSend(config.OTP_GROUP_ID, `🟢 *KMKI Bot is now ACTIVE!*\n${activeBots.length} bots running.`, {
        parse_mode: 'Markdown'
      });
      console.log(`[BOT] Sent active notification to group ${config.OTP_GROUP_ID}`);
    } catch (e) {
      console.log(`[BOT] Could not send active notification to group: ${e.message}`);
    }
  }

  // ==========================================
  // Daily Auto Cleanup (Runs at 23:59 Local Time)
  // ==========================================
  let lastCleanupDate = null;
  setInterval(async () => {
    const localOffsetHours = config.TIMEZONE_OFFSET !== undefined ? config.TIMEZONE_OFFSET : 6;
    const now = new Date();
    const localTime = new Date(now.getTime() + localOffsetHours * 3600000);
    
    // Trigger at 23:59 (11:59 PM) local time
    if (localTime.getUTCHours() === 23 && localTime.getUTCMinutes() === 59) {
      const localDateStr = localTime.toISOString().split('T')[0];
      
      if (lastCleanupDate !== localDateStr) {
        lastCleanupDate = localDateStr;
        console.log('[CLEANUP] Starting daily auto-cleanup and sending stats...');
        
        try {
          const db = require('./database');
          const sign = localOffsetHours >= 0 ? '+' : '';
          const offsetString = `${sign}${localOffsetHours} hours`;
          
          // Get today's stats from DB
          const todayLogs = db.prepare(`
            SELECT panel_name, app_id, phone_number, otp_code 
            FROM otp_logs 
            WHERE date(received_at, ?) = ?
          `).all(offsetString, localDateStr);
          
          if (activeBots.length > 0) {
            const primaryBot = activeBots[0];
            const statsText = primaryBot._getStatsText(todayLogs, localDateStr);
            const msgText = `🧹 *Daily Auto-Cleanup Report*\n\n` + statsText;
            
            // Send to all admins
            if (config.ADMIN_USER_IDS && Array.isArray(config.ADMIN_USER_IDS)) {
              for (const adminId of config.ADMIN_USER_IDS) {
                await primaryBot._safeSend(adminId, msgText, { parse_mode: 'Markdown' });
              }
            }
          }
          
          // Delete logs from DB (delete all logs, as they are no longer needed for stats)
          const result = db.prepare(`DELETE FROM otp_logs`).run();
          console.log(`[CLEANUP] DB cleanup finished successfully. Deleted ${result.changes} rows.`);
          
          // Clear memory cache if needed
          if (monitor) {
             monitor.processedMessages.clear();
             console.log(`[CLEANUP] Memory cache cleared.`);
          }
          
        } catch (err) {
          console.error('[CLEANUP] Error during daily cleanup:', err);
        }
      }
    }
  }, 30000); // Check every 30 seconds

  // গ্রেসফুল শাটডাউন
  process.on('SIGINT', () => {
    console.log('\n\nShutting down...');
    monitor.stop();
    for (const b of activeBots) b.stopPolling();
    process.exit(0);
  });

  process.on('SIGTERM', () => {
    monitor.stop();
    for (const b of activeBots) b.stopPolling();
    process.exit(0);
  });
}

main().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});
