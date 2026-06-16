// ============================================================
// TELEGRAM BOT - মূল বট লজিক (FIXED v6 - DIRECT MODE)
// Library HTTP সম্পূর্ণ BYPASS — সব API call raw HTTPS (IPv4)
// Library শুধু processUpdate() এর জন্য ব্যবহৃত
// v8.3: Country flag buttons + Markdown fix + No time limit
// ============================================================

const TelegramBot = require('node-telegram-bot-api');
const https = require('https');
const config = require('../config');
const panelManager = require('./services/panel-manager');
const numberManager = require('./services/number-manager');
const db = require('../database');

class OTPBot {
  constructor(token = config.TELEGRAM_BOT_TOKEN, botName = 'Unknown Bot') {
    this.token = token;
    this.botName = botName;
    // Library শুধু event processing এর জন্য — polling OFF
    const botOptions = {
      polling: false,  // ❌ Library polling সম্পূর্ণ বন্ধ
      onlyFirstMatch: true
    };

    this.bot = new TelegramBot(this.token, botOptions);
    this.otpMonitor = null;

    // Direct HTTPS settings
    this._httpsAgent = new https.Agent({ family: 4, keepAlive: true });
    this._apiBase = `https://api.telegram.org/bot${this.token}`;

    // Custom polling state
    this._pollingActive = false;
    this._pollOffset = 0;
    this._pollErrors = 0;
    this._isPollingHealthy = true;
    this._lastPollErrorLog = 0;

    // Admin Range Add v8 flow state: userId -> { step, appId, panelIdx, panelName, rangeName, allRanges }
    this._rangeAddState = new Map();

    // Admin Add Panel flow state: userId -> { step, name, baseUrl, username, password, loginPageUrl, signinUrl, dashboardPath }
    this._addPanelState = new Map();

    // Country selection state: userId -> { appId, groups: [{flag, displayName, ranges, totalCount}] }
    this._countrySelectState = new Map();

    this._setupHandlers();
    console.log('Bot created (v8.3 - country flags, markdown fix)');
  }

  // ============================================================
  // DIRECT HTTPS API - Library bypass, raw HTTPS with IPv4
  // ============================================================

  _apiCall(method, params = {}, timeoutMs = 10000) {
    return new Promise((resolve, reject) => {
      const postData = JSON.stringify(params);
      const urlObj = new URL(`${this._apiBase}/${method}`);
      const options = {
        hostname: urlObj.hostname,
        path: urlObj.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(postData)
        },
        agent: this._httpsAgent,
        timeout: timeoutMs
      };

      const req = https.request(options, (res) => {
        let body = '';
        res.on('data', chunk => body += chunk);
        res.on('end', () => {
          try {
            const parsed = JSON.parse(body);
            if (parsed.ok) {
              resolve(parsed);
            } else {
              reject(new Error(parsed.description || 'API error'));
            }
          } catch (e) {
            reject(new Error('JSON parse error: ' + body.slice(0, 200)));
          }
        });
      });

      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('ETIMEDOUT')); });
      req.write(postData);
      req.end();
    });
  }

  // ============================================================
  // SAFE WRAPPERS
  // ============================================================

  async _safeSend(chatId, text, options = {}) {
    try {
      const result = await this._apiCall('sendMessage', {
        chat_id: chatId,
        text: text,
        ...options
      });
      return result.result;
    } catch (err) {
      console.error(`[SEND] fail -> chat ${chatId} (Bot: ${this.botName}): ${err.message}`);
      await new Promise(r => setTimeout(r, 500));
      try {
        const result = await this._apiCall('sendMessage', {
          chat_id: chatId,
          text: text,
          ...options
        });
        console.log(`[SEND] retry OK -> chat ${chatId}`);
        return result.result;
      } catch (retryErr) {
        console.error(`[SEND] retry fail -> chat ${chatId} (Bot: ${this.botName}): ${retryErr.message}`);
        return null;
      }
    }
  }

  async _safeEdit(chatId, messageId, text, options = {}) {
    try {
      const result = await this._apiCall('editMessageText', {
        chat_id: chatId,
        message_id: messageId,
        text: text,
        ...options
      });
      return result.result;
    } catch (err) {
      console.error(`[EDIT] fail -> chat ${chatId}, msg ${messageId}: ${err.message}`);
      return null;
    }
  }

  async _safeAnswer(callbackQueryId, text = '') {
    try {
      const params = { callback_query_id: callbackQueryId };
      if (text) params.text = text;
      await this._apiCall('answerCallbackQuery', params);
    } catch (err) {
      console.error(`[ANSWER] fail: ${err.message}`);
    }
  }

  // ============================================================
  // CUSTOM POLLING
  // ============================================================

  async _customPoll() {
    console.log('[POLL] Custom polling started (direct HTTPS - Long Polling)');

    while (this._pollingActive) {
      let hasUpdates = false;
      try {
        const result = await this._apiCall('getUpdates', {
          offset: this._pollOffset,
          timeout: 10, // 10s long-polling for instant delivery
          allowed_updates: ['message', 'callback_query']
        }, 30000); // 30s HTTP timeout for long-polling

        if (result.ok && result.result && result.result.length > 0) {
          hasUpdates = true;
          for (const update of result.result) {
            this._pollOffset = update.update_id + 1;
            try {
              // Asynchronously process without blocking
              this.bot.processUpdate(update);
            } catch (e) {
              console.error(`[POLL] processUpdate error: ${e.message}`);
            }
          }
          this._pollErrors = 0;
          this._isPollingHealthy = true;
        }
      } catch (err) {
        this._pollErrors++;
        const now = Date.now();
        this._isPollingHealthy = false;

        if (now - this._lastPollErrorLog >= 300000) {
          console.error(`\n[POLL] Error #${this._pollErrors}: ${err.message}\n`);
          this._lastPollErrorLog = now;
        }

        if (this._pollErrors > 5) {
          await new Promise(r => setTimeout(r, 10000));
          this._pollErrors = 0;
        }
      }

      // If we got updates, fetch next batch immediately to handle high concurrency
      await new Promise(r => setTimeout(r, hasUpdates ? 50 : 500));
    }
  }

  // ============================================================
  // BOT STARTUP
  // ============================================================

  async startBot() {
    try {
      console.log('[*] Setting up bot...');

      console.log('[*] Direct connectivity test...');
      const startTime = Date.now();
      try {
        const meResult = await this._apiCall('getMe');
        const elapsed = Date.now() - startTime;
        if (meResult.ok) {
          console.log(`[*] getMe OK in ${elapsed}ms: @${meResult.result.username}`);
        } else {
          throw new Error('getMe not ok');
        }
      } catch (directErr) {
        console.error(`[!] getMe FAILED: ${directErr.message}`);
        console.error('[!] Internet connection problem — check and restart');
        return false;
      }

      console.log('[*] Webhook cleared');
      try {
        await this._apiCall('deleteWebhook', { drop_pending_updates: true });
      } catch (e) { }

      console.log('[*] Starting polling (direct HTTPS)...');
      this._pollingActive = true;
      this._customPoll();

      setTimeout(() => {
        if (this._isPollingHealthy) {
          console.log('[*] Polling is ACTIVE');
        } else {
          console.error('[!] Polling has errors but still running...');
        }
      }, 3000);

      if (config.ADMIN_USER_ID && config.ADMIN_USER_ID !== 0) {
        setTimeout(async () => {
          try {
            await this._apiCall('sendMessage', {
              chat_id: config.ADMIN_USER_ID,
              text: '🟢 Bot is now online!\n\nSend /start to begin.',
              parse_mode: 'Markdown'
            });
            console.log('[*] Test message sent to admin');
          } catch (e) {
            console.error(`[!] Test message failed: ${e.message}`);
          }
        }, 2000);
      }

      return true;
    } catch (error) {
      console.error(`❌ Bot start error: ${error.message}`);
      return false;
    }
  }

  stopPolling() {
    this._pollingActive = false;
  }

  isPolling() {
    return this._pollingActive && this._isPollingHealthy;
  }

  // ============================================================
  // EVENT HANDLERS
  // ============================================================

  _setupHandlers() {
    this.bot.onText(/\/start/, (msg) => {
      console.log(`[EVENT] /start from user ${msg.from.id}`);
      this._handleStart(msg).catch(e => console.error(`[ERROR] /start: ${e.message}`));
    });

    this.bot.onText(/\/help/, (msg) => {
      this._handleHelp(msg).catch(e => console.error(`[ERROR] /help: ${e.message}`));
    });

    this.bot.onText(/\/status/, (msg) => {
      this._handleStatus(msg).catch(e => console.error(`[ERROR] /status: ${e.message}`));
    });

    this.bot.onText(/\/myotp/, (msg) => {
      this._handleMyOTP(msg).catch(e => console.error(`[ERROR] /myotp: ${e.message}`));
    });

    this.bot.onText(/\/cancel/, (msg) => {
      this._handleCancel(msg).catch(e => console.error(`[ERROR] /cancel: ${e.message}`));
    });

    this.bot.onText(/\/retry/, (msg) => {
      this._handleRetry(msg).catch(e => console.error(`[ERROR] /retry: ${e.message}`));
    });

    this.bot.onText(/\/myid/, (msg) => {
      this._handleMyId(msg).catch(e => console.error(`[ERROR] /myid: ${e.message}`));
    });

    this.bot.onText(/\/adduser (.+)/, (msg, match) => {
      this._handleAddUser(msg, match).catch(e => console.error(`[ERROR] /adduser: ${e.message}`));
    });

    this.bot.onText(/\/removeuser (.+)/, (msg, match) => {
      this._handleRemoveUser(msg, match).catch(e => console.error(`[ERROR] /removeuser: ${e.message}`));
    });

    this.bot.onText(/\/addadmin (.+)/, (msg, match) => {
      this._handleAddAdmin(msg, match).catch(e => console.error(`[ERROR] /addadmin: ${e.message}`));
    });

    this.bot.onText(/\/removeadmin (.+)/, (msg, match) => {
      this._handleRemoveAdmin(msg, match).catch(e => console.error(`[ERROR] /removeadmin: ${e.message}`));
    });

    this.bot.onText(/\/admins/, (msg) => {
      this._handleAdminsList(msg).catch(e => console.error(`[ERROR] /admins: ${e.message}`));
    });

    this.bot.onText(/\/users/, (msg) => {
      this._handleUsers(msg).catch(e => console.error(`[ERROR] /users: ${e.message}`));
    });

    this.bot.onText(/\/ranges/, (msg) => {
      this._handleRanges(msg).catch(e => console.error(`[ERROR] /ranges: ${e.message}`));
    });

    this.bot.onText(/\/stats/, (msg) => {
      this._handleStats(msg).catch(e => console.error(`[ERROR] /stats: ${e.message}`));
    });

    // ইনলাইন বাটন কলব্যাক
    this.bot.on('callback_query', (query) => {
      console.log(`[EVENT] callback: ${query.data} from user ${query.from.id}`);
      this._handleCallback(query).catch(e => console.error(`[ERROR] callback: ${e.message}`));
    });

    // প্লেইন টেক্সট মেসেজ
    this.bot.on('message', (msg) => {
      if (msg.document) {
        this._handleDocumentUpload(msg).catch(e => console.error(`[ERROR] doc upload: ${e.message}`));
        return;
      }
      if (msg.text && !msg.text.startsWith('/')) {
        this._handleTextMessage(msg).catch(e => console.error(`[ERROR] text: ${e.message}`));
      }
    });
  }

  // ============================================================
  // COMMAND HANDLERS
  // ============================================================

  async _handleStart(msg) {
    const userId = msg.from.id;
    const userName = msg.from.username || msg.from.first_name || 'Unknown';

    console.log(`[HANDLER] /start -> user ${userId} (${userName})`);

    if (!this._isAuthorized(userId)) {
      await this._safeSend(userId, '⛔ *Not Authorized!*\n\nYou do not have permission to use this bot.', {
        parse_mode: 'Markdown'
      });
      return;
    }

    this._registerUser(userId, userName);

    const welcomeMessage = `👋 *Welcome ${this._escapeMd(userName)}!*\n\n` +
      `🤖 I am your *SMS OTP Bot*. I will help you get verification codes (OTP) for various social media apps.\n\n` +
      `⚡ *How to use:*\n` +
      `1️⃣ Select an app from below\n` +
      `2️⃣ You will get a number from the panel\n` +
      `3️⃣ Send OTP to the number\n` +
      `4️⃣ You will receive the OTP here instantly 🔥`;

    const keyboard = this._getAppMenuKeyboard(userId);

    await this._safeSend(userId, welcomeMessage, {
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: keyboard }
    });
  }

  async _handleHelp(msg) {
    const userId = msg.from.id;
    if (!this._isAuthorized(userId)) return;

    const helpText = `📖 *Help Guide*\n\n` +
      `🔹 */start* - Start bot & main menu\n` +
      `🔹 */status* - View panel status\n` +
      `🔹 */myotp* - View current active OTPs\n` +
      `🔹 */cancel* - Cancel ongoing requests\n` +
      `🔹 */retry* - Request a new number\n\n` +
      `⚠️ *Important Info:*\n` +
      `• You will get ${config.NUMBERS_PER_REQUEST} numbers per request\n` +
      `• Numbers stay active until you request a new one\n` +
      `• Each number can only be used by one user at a time\n` +
      `• OTP is received in real-time (checked every ${config.OTP_POLL_INTERVAL} seconds)\n\n` +
      `❓ If you face any issues, contact the admin.`;

    await this._safeSend(userId, helpText, {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [[{ text: '🏠 Main Menu', callback_data: 'main_menu' }]]
      }
    });
  }

  async _handleStatus(msg) {
    const userId = msg.from.id;
    if (!this._isAdmin(userId)) {
      await this._safeSend(userId, '⛔ This command can only be used by admin.');
      return;
    }

    const statuses = panelManager.getStatus();
    let statusText = '📊 *Panel Status*\n\n';

    for (const s of statuses) {
      const icon = s.isLoggedIn ? '🟢' : '🔴';
      statusText += `${icon} *${this._escapeMd(s.name)}*\n`;
      statusText += `   Status: ${s.isLoggedIn ? 'Connected ✅' : 'Disconnected ❌'}\n`;
      if (s.lastLogin) {
        statusText += `   Last login: ${s.lastLogin}\n`;
      }
      statusText += '\n';
    }

    const telegramStatus = this._isPollingHealthy ? '🟢 Normal' : '🔴 Issue';
    statusText += `📡 Telegram: ${telegramStatus}\n`;

    await this._safeSend(userId, statusText, {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [{ text: '🔄 Refresh', callback_data: 'refresh_status' }],
          [{ text: '🏠 Main Menu', callback_data: 'main_menu' }]
        ]
      }
    });
  }

  async _handleMyOTP(msg) {
    const userId = msg.from.id;
    if (!this._isAuthorized(userId)) return;

    const allocations = numberManager.getUserActiveNumbers(userId);

    if (allocations.length === 0) {
      await this._safeSend(userId, '📭 No active numbers currently. Select a new app.', {
        reply_markup: {
          inline_keyboard: [[{ text: '📱 Select an App', callback_data: 'main_menu' }]]
        }
      });
      return;
    }

    let otpText = `📱 *Your Active Numbers:*\n\n`;
    for (const alloc of allocations) {
      const app = config.SUPPORTED_APPS.find(a => a.id === alloc.app_id);
      const otpPart = alloc.otp_code ? `✅ OTP: *${alloc.otp_code}*` : '⏳ Waiting...';
      otpText += `📱 \`${alloc.phone_number}\`\n`;
      otpText += `   ${otpPart}\n`;
      otpText += `   📦 ${app ? app.name : alloc.app_id}\n`;
      otpText += `   🖥️ ${alloc.panel_name}\n\n`;
    }

    await this._safeSend(userId, otpText, {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [{ text: '🔄 Refresh', callback_data: 'refresh_myotp' }],
          [{ text: '❌ Cancel All', callback_data: 'cancel_all' }],
          [{ text: '🏠 Main Menu', callback_data: 'main_menu' }]
        ]
      }
    });
  }

  async _handleCancel(msg) {
    const userId = msg.from.id;
    if (!this._isAuthorized(userId)) return;

    numberManager.releaseUserNumbers(userId);
    await this._safeSend(userId, '✅ All requests have been cancelled.');
    await this._safeSend(userId, '📱 *Which app do you need OTP for?* Select from below:', {
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: this._getAppMenuKeyboard(userId) }
    });
  }

  async _handleRetry(msg) {
    const userId = msg.from.id;
    if (!this._isAuthorized(userId)) return;

    const session = db.prepare('SELECT * FROM user_sessions WHERE telegram_user_id = ?').get(userId);
    if (session && session.selected_app) {
      await this._requestNumbers(userId, session.selected_app);
    } else {
      await this._safeSend(userId, '📱 *Which app do you need OTP for?* Select from below:', {
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: this._getAppMenuKeyboard(userId) }
      });
    }
  }

  // ============================================================
  // CALLBACK HANDLERS
  // ============================================================

  async _handleCallback(query) {
    const userId = query.from.id;
    const data = query.data;

    if (!this._isAuthorized(userId)) {
      await this._safeAnswer(query.id, 'Not authorized!');
      return;
    }

    // ---- মূল মেনু ----
    if (data === 'main_menu') {
      await this._safeAnswer(query.id); // Stop spinner immediately
      this._rangeAddState.delete(userId);
      await this._safeEdit(userId, query.message.message_id,
        '📱 *Which app do you need OTP for?* Select from below:',
        {
          parse_mode: 'Markdown',
          reply_markup: { inline_keyboard: this._getAppMenuKeyboard(userId) }
        }
      );
      return;
    }

    // ---- অ্যাপ সিলেক্ট → Country/Range buttons দেখাও ----
    if (data.startsWith('app_')) {
      const appId = data.replace('app_', '');
      await this._safeAnswer(query.id);
      await this._showCountryButtons(userId, appId, query.message.message_id);
      return;
    }

    // ---- Country সিলেক্ট → নাম্বর আনো ----
    if (data.startsWith('cr_')) {
      const groupIndex = parseInt(data.replace('cr_', ''), 10);
      await this._safeAnswer(query.id);
      await this._showCountryConfirm(userId, groupIndex, query.message.message_id);
      return;
    }

    // ---- Get Numbers button click → নাম্বর আনো ----
    if (data.startsWith('gn_')) {
      await this._safeAnswer(query.id);
      await this._handleCountrySelect(userId, query.message.message_id);
      return;
    }

    // ---- Range সিলেক্ট → নাম্বার আনো (legacy fallback) ----
    if (data.startsWith('range_')) {
      const parts = data.replace('range_', '').split('__');
      const appId = parts[0];
      const rangeName = parts.slice(1).join('__');
      await this._safeAnswer(query.id);
      await this._requestNumbers(userId, appId, rangeName, query.message.message_id);
      return;
    }

    // ---- Change বাটন → পুরনো নম্বর release করে নতুন নম্বর দাও ----
    if (data.startsWith('change_num_')) {
      const appId = data.replace('change_num_', '');
      await this._safeAnswer(query.id); // Immediately acknowledge so Telegram spinner stops
      numberManager.releaseUserNumbers(userId);

      const state = this._countrySelectState.get(userId);
      if (state && state.appId === appId && state.selectedIndex !== undefined) {
        await this._handleCountrySelect(userId, query.message.message_id);
      } else {
        await this._requestNumbers(userId, appId, null, query.message.message_id);
      }
      return;
    }

    // ---- OTP সম্পন্ন ----
    if (data.startsWith('otp_done_')) {
      const phoneNumber = data.replace('otp_done_', '');
      db.prepare('UPDATE number_allocations SET status = "completed" WHERE phone_number = ? AND telegram_user_id = ?')
        .run(phoneNumber, userId);
      await this._safeAnswer(query.id, '✅ Thank you!');
      return;
    }

    // ---- একটি নাম্বার রিলিজ করে নতুন নাম্বার আনা ----
    if (data.startsWith('newnum_')) {
      const appId = data.split('_')[1];
      const phoneNumber = data.split('_').slice(2).join('_');
      await this._safeAnswer(query.id, '🔄 Fetching new number...');
      numberManager.releaseSingleNumber(userId, phoneNumber);
      console.log(`[RELEASE] User ${userId} released number ${phoneNumber}`);
      await this._requestSingleNumber(userId, appId, query.message.message_id);
      return;
    }

    // ---- OTP রিট্রাই ----
    if (data.startsWith('otp_retry_')) {
      const appId = data.replace('otp_retry_', '');
      await this._safeAnswer(query.id, '🔄 Fetching new number...');
      await this._requestNumbers(userId, appId, null, query.message.message_id);
      return;
    }

    // ---- স্ট্যাটাস রিফ্রেশ ----
    if (data === 'refresh_status') {
      await this._safeAnswer(query.id, '🔄 Refreshing...');
      await this._handleStatus({ from: { id: userId } });
      return;
    }

    // ---- MyOTP রিফ্রেশ ----
    if (data === 'refresh_myotp') {
      await this._safeAnswer(query.id, '🔄 Refreshing...');
      await this._handleMyOTP({ from: { id: userId } });
      return;
    }

    // ---- Ranges রিফ্রেশ ----
    if (data === 'refresh_ranges') {
      await this._safeAnswer(query.id, '🔄 Refreshing...');
      await this._handleRanges({ from: { id: userId } });
      return;
    }

    // ---- Stats ভিউ ও রিফ্রেশ ----
    if (data === 'admin_view_stats' || data === 'refresh_stats') {
      if (!this._isAdmin(userId)) {
        await this._safeAnswer(query.id, '⛔ Admin only!');
        return;
      }
      await this._safeAnswer(query.id, '📊 Fetching stats...');
      await this._showDataStats(userId, query.message.message_id);
      return;
    }

    // ---- Add New Admin Menu ----
    if (data === 'admin_add_admin_menu') {
      if (!this._isAdmin(userId)) {
        await this._safeAnswer(query.id, '⛔ Admin only!');
        return;
      }
      await this._safeAnswer(query.id);
      await this._safeSend(userId, 
        '👑 *Add New Admin*\n\nTo add a new admin, please send their Telegram User ID below.\n\nType: `/addadmin <USER_ID>`\nExample: `/addadmin 123456789`', 
        { parse_mode: 'Markdown' }
      );
      return;
    }

    // ---- সব বাতিল ----
    if (data === 'cancel_all') {
      numberManager.releaseUserNumbers(userId);
      await this._safeAnswer(query.id, '✅ All cancelled!');
      await this._safeEdit(userId, query.message.message_id,
        '📱 *Which app do you need OTP for?* Select from below:',
        { parse_mode: 'Markdown', reply_markup: { inline_keyboard: this._getAppMenuKeyboard(userId) } }
      );
      return;
    }

    // ============================================================
    // ADMIN: Range Add v8 flow callbacks
    // নতুন ফ্লো: App → Panel → Range → Instant Add
    // ============================================================

    // ---- Range Add শুরু ----
    if (data === 'admin_range_add') {
      if (!this._isAdmin(userId)) {
        await this._safeAnswer(query.id, '⛔ Admin only!');
        return;
      }
      await this._safeAnswer(query.id);
      await this._showUploadAppSelect(userId, query.message.message_id);
      return;
    }

    if (data === 'admin_panel_settings') {
      if (!this._isAdmin(userId)) {
        await this._safeAnswer(query.id, '⛔ Admin only!');
        return;
      }
      await this._safeAnswer(query.id);
      await this._showPanelSettings(userId, query.message.message_id);
      return;
    }

    if (data.startsWith('toggle_panel:')) {
      if (!this._isAdmin(userId)) return;
      const panelName = data.replace('toggle_panel:', '');
      const db = require('../database');
      const currentState = panelManager.isPanelEnabled(panelName) ? 1 : 0;
      const newState = currentState === 1 ? 0 : 1;

      db.prepare(`
        INSERT INTO panel_settings (panel_name, is_enabled) VALUES (?, ?)
        ON CONFLICT(panel_name) DO UPDATE SET is_enabled = excluded.is_enabled
      `).run(panelName, newState);

      if (newState === 1) {
        // Panel just activated — trigger background login immediately
        await this._safeAnswer(query.id, `⏳ Activating ${panelName}...`);
        await this._showPanelSettings(userId, query.message.message_id);

        // Non-blocking background login
        panelManager.loginPanel(panelName).then(success => {
          console.log(`[TOGGLE] ${panelName} auto-login: ${success ? 'OK' : 'FAILED'}`);
        }).catch(e => {
          console.error(`[TOGGLE] ${panelName} auto-login error: ${e.message}`);
        });
      } else {
        // Panel deactivated — just update
        await this._safeAnswer(query.id, `🔴 ${panelName} Disabled`);
        await this._showPanelSettings(userId, query.message.message_id);
      }
      return;
    }

    if (data.startsWith('delete_panel:')) {
      if (!this._isAdmin(userId)) {
        await this._safeAnswer(query.id, '⛔ Admin only!');
        return;
      }
      const panelName = data.replace('delete_panel:', '');
      try {
        panelManager.removePanel(panelName);
        await this._safeAnswer(query.id, `🗑️ Deleted ${panelName}!`);
      } catch (err) {
        await this._safeAnswer(query.id, `❌ ${err.message}`);
      }
      await this._showPanelSettings(userId, query.message.message_id);
      return;
    }

    if (data === 'add_panel_start') {
      if (!this._isAdmin(userId)) {
        await this._safeAnswer(query.id, '⛔ Admin only!');
        return;
      }
      await this._safeAnswer(query.id);
      this._addPanelState.set(userId, { step: 'type' });
      await this._safeEdit(userId, query.message.message_id,
        '➕ *Add New SMS Panel*\n\nStep 1: Select the **Panel Type**:\n\n' +
        '🐺 *Wolf (INTS)* — Traditional scraping-based panels (most common)\n' +
        '🔌 *INS API* — Modern REST API-based panels (e.g. http://203.161.58.20)\n' +
        '🟣 *Purple SMS* — API/Math-captcha based panels (e.g. http://85.195.94.50)',
        {
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [
              [
                { text: '🐺 Wolf (INTS)', callback_data: 'add_panel_type_wolf' },
                { text: '🔌 INS API', callback_data: 'add_panel_type_ins' }
              ],
              [
                { text: '🟣 Purple SMS', callback_data: 'add_panel_type_purple' }
              ],
              [{ text: '❌ Cancel', callback_data: 'add_panel_cancel' }]
            ]
          }
        }
      );
      return;
    }

    if (data === 'add_panel_type_wolf' || data === 'add_panel_type_ins' || data === 'add_panel_type_purple') {
      if (!this._isAdmin(userId)) return;
      await this._safeAnswer(query.id);
      const state = this._addPanelState.get(userId);
      if (!state || state.step !== 'type') return;
      
      if (data === 'add_panel_type_ins') {
        state.type = 'ins';
      } else if (data === 'add_panel_type_purple') {
        state.type = 'purple';
      } else {
        state.type = 'wolf';
      }
      
      state.step = 'name';
      let typeLabel = '🐺 Wolf (INTS)';
      if (state.type === 'ins') typeLabel = '🔌 INS API';
      else if (state.type === 'purple') typeLabel = '🟣 Purple SMS';

      await this._safeEdit(userId, query.message.message_id,
        `➕ *Add New SMS Panel* \[${typeLabel}\]\n\nStep 2: Please enter the **Name** of the panel:`,
        {
          parse_mode: 'Markdown',
          reply_markup: { inline_keyboard: [[{ text: '❌ Cancel', callback_data: 'add_panel_cancel' }]] }
        }
      );
      return;
    }

    if (data === 'add_panel_cancel') {
      this._addPanelState.delete(userId);
      await this._safeAnswer(query.id, '❌ Cancelled');
      await this._showPanelSettings(userId, query.message.message_id);
      return;
    }

    if (data === 'add_panel_use_default') {
      if (!this._isAdmin(userId)) return;
      await this._safeAnswer(query.id);
      const state = this._addPanelState.get(userId);
      if (!state || state.step !== 'paths') return;

      state.loginPageUrl = '/ints/login';
      state.signinUrl = '/ints/signin';
      state.dashboardPath = '/ints/agent';

      await this._finalizePanelAdd(userId, query.message.message_id);
      return;
    }

    if (data === 'add_panel_use_ins_defaults') {
      if (!this._isAdmin(userId)) return;
      await this._safeAnswer(query.id);
      const state = this._addPanelState.get(userId);
      if (!state || state.step !== 'paths') return;

      state.loginPageUrl = '/api/auth/login';
      state.signinUrl = '/api/auth/login';
      state.dashboardPath = '';

      await this._finalizePanelAdd(userId, query.message.message_id);
      return;
    }

    if (data === 'add_panel_use_custom') {
      if (!this._isAdmin(userId)) return;
      await this._safeAnswer(query.id);
      const state = this._addPanelState.get(userId);
      if (!state || state.step !== 'paths') return;

      state.step = 'login_path';
      await this._safeEdit(userId, query.message.message_id,
        '📝 Enter the **Login Page URL Path** (e.g., `/ints/login` or `/login`):',
        {
          parse_mode: 'Markdown',
          reply_markup: { inline_keyboard: [[{ text: '❌ Cancel', callback_data: 'add_panel_cancel' }]] }
        }
      );
      return;
    }

    if (data.startsWith('up_app:')) {
      if (!this._isAdmin(userId)) {
        await this._safeAnswer(query.id, '⛔ Admin only!');
        return;
      }
      const appId = data.replace('up_app:', '');
      await this._safeAnswer(query.id);
      await this._promptFileUpload(userId, appId, query.message.message_id);
      return;
    }

    if (data === 'up_cancel') {
      this._rangeAddState.delete(userId);
      await this._safeAnswer(query.id, '❌ Cancelled');
      await this._safeEdit(userId, query.message.message_id, '📱 *Which app do you need OTP for?* Select from below:', {
        parse_mode: 'Markdown', reply_markup: { inline_keyboard: this._getAppMenuKeyboard(userId) }
      });
      return;
    }

    if (data.startsWith('up_view_countries:')) {
      if (!this._isAdmin(userId)) {
        await this._safeAnswer(query.id, '⛔ Admin only!');
        return;
      }
      const appId = data.replace('up_view_countries:', '');
      await this._safeAnswer(query.id);
      await this._showCountriesForApp(userId, appId, query.message.message_id);
      return;
    }

    if (data.startsWith('up_clr_c:')) {
      if (!this._isAdmin(userId)) {
        await this._safeAnswer(query.id, '⛔ Admin only!');
        return;
      }
      const parts = data.split(':');
      const appId = parts[1];
      const countryName = parts.slice(2).join(':');

      await this._safeAnswer(query.id, '🗑 Clearing...');

      const db = require('../database');
      const dbNums = db.prepare('SELECT phone_number FROM custom_numbers WHERE app_id = ?').all(appId);

      let deletedCount = 0;
      const deleteStmt = db.prepare('DELETE FROM custom_numbers WHERE app_id = ? AND phone_number = ?');

      db.transaction(() => {
        for (const row of dbNums) {
          const cInfo = this._getCountryInfo(row.phone_number);
          const cName = cInfo && cInfo.name !== 'Unknown' ? cInfo.name : 'Custom';
          if (cName === countryName) {
            deleteStmt.run(appId, row.phone_number);
            deletedCount++;
          }
        }
      })();

      const app = require('../config').SUPPORTED_APPS.find(a => a.id === appId);
      const appName = app ? app.name : appId;

      await this._safeEdit(userId, query.message.message_id,
        `✅ Cleared ${deletedCount} custom numbers for *${countryName}* under *${appName}*.`,
        {
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [[{ text: '« Back to Countries', callback_data: `up_view_countries:${appId}` }]]
          }
        }
      );
      return;
    }

    // ---- Admin: Toggle Bot ----
    if (data === 'admin_toggle_bot') {
      if (!this._isAdmin(userId)) {
        await this._safeAnswer(query.id, '⛔ Admin only!');
        return;
      }
      global.botDisabled = !global.botDisabled;

      const newStatus = global.botDisabled ? 'Deactivated' : 'Activated';
      await this._safeAnswer(query.id, `Bot ${newStatus}`);

      try {
        await this.bot.editMessageReplyMarkup(
          { inline_keyboard: this._getAppMenuKeyboard(userId) },
          { chat_id: userId, message_id: query.message.message_id }
        );
      } catch (e) { }

      if (config.OTP_GROUP_ID) {
        await this._safeSend(config.OTP_GROUP_ID, `Bot ${newStatus} Jonab`);
      }
      return;
    }

    // ---- Admin: Mapping দেখুন ----
    if (data === 'admin_view_mapping') {
      if (!this._isAdmin(userId)) {
        await this._safeAnswer(query.id, '⛔ Admin only!');
        return;
      }
      await this._safeAnswer(query.id);
      await this._showCurrentMapping(userId, query.message.message_id);
      return;
    }

    // ---- v8: App সিলেক্ট (ra_app:appId) ----
    // কোন অ্যাপের জন্য range add করতে চান
    if (data.startsWith('ra_app:')) {
      const appId = data.replace('ra_app:', '');
      await this._safeAnswer(query.id);
      await this._handleRangeAppSelect(userId, appId, query.message.message_id);
      return;
    }

    // ---- v8: Panel সিলেক্ট (ra_panel:panelIdx) ----
    // কোন প্যানেল থেকে range add করতে চান
    if (data.startsWith('ra_panel:')) {
      const panelIdx = parseInt(data.replace('ra_panel:', ''), 10);
      await this._safeAnswer(query.id);
      await this._handleRangePanelSelect(userId, panelIdx, query.message.message_id);
      return;
    }

    // ---- v8: Range ক্লিক → Instant Add (ra_range:rangeIdx) ----
    // নির্দিষ্ট range ক্লিক করলে সাথে সাথে mapping সেভ
    if (data.startsWith('ra_range:')) {
      const rangeIdx = parseInt(data.replace('ra_range:', ''), 10);
      await this._safeAnswer(query.id, '✅ Adding...');
      await this._handleRangeInstantAdd(userId, rangeIdx, query.message.message_id);
      return;
    }

    // ---- v8: Back to App লিস্ট ----
    if (data === 'ra_back_apps') {
      await this._safeAnswer(query.id);
      await this._startRangeAdd(userId, query.message.message_id);
      return;
    }

    // ---- v8: Back to Panel লিস্ট ----
    if (data === 'ra_back_panels') {
      await this._safeAnswer(query.id);
      await this._handleRangeBackToPanels(userId, query.message.message_id);
      return;
    }

    // ---- v8: Cancel ----
    if (data === 'ra_cancel') {
      this._rangeAddState.delete(userId);
      await this._safeAnswer(query.id, '❌ Cancelled');
      await this._safeEdit(userId, query.message.message_id,
        '📱 *Which app do you need OTP for?* Select from below:',
        { parse_mode: 'Markdown', reply_markup: { inline_keyboard: this._getAppMenuKeyboard(userId) } }
      );
      return;
    }

    // ---- Mapping থেকে ডিলিট (delmap:appId:N) ----
    if (data.startsWith('delmap:')) {
      if (!this._isAdmin(userId)) {
        await this._safeAnswer(query.id, '⛔ Admin only!');
        return;
      }
      const parts = data.replace('delmap:', '').split(':');
      const appId = parts[0];
      const idx = parseInt(parts[1], 10);
      await this._safeAnswer(query.id);
      await this._deleteMappingEntry(userId, appId, idx, query.message.message_id);
      return;
    }

    await this._safeAnswer(query.id, 'Unknown action');
  }

  // ============================================================
  // CORE FUNCTIONS — Country/Range Selection
  // ============================================================

  /**
   * App সিলেক্টের পর কান্ট্রি buttons দেখাও
   * ranges কে country অনুযায়ী group করে flag + country name + total count দেখায়
   */
  async _showCountryButtons(userId, appId, messageId) {
    const app = config.SUPPORTED_APPS.find(a => a.id === appId);
    const appName = app ? app.name : appId;

    // Fetch custom numbers from DB for this app
    const db = require('../database');
    const customNumRows = db.prepare('SELECT phone_number FROM custom_numbers WHERE app_id = ? AND is_used = 0').all(appId);

    const customGroups = new Map();
    for (const row of customNumRows) {
      const cInfo = this._getCountryInfo(row.phone_number);
      const countryName = cInfo && cInfo.name !== 'Unknown' ? cInfo.name : 'Custom';
      const flag = cInfo ? cInfo.flag : '🌐';
      const key = countryName.toLowerCase().replace(/\s+/g, '_');

      if (!customGroups.has(key)) {
        customGroups.set(key, {
          flag: flag,
          displayName: countryName,
          numbers: [],
        });
      }
      customGroups.get(key).numbers.push(row.phone_number);
    }

    const ranges = [];
    for (const [key, data] of customGroups.entries()) {
      ranges.push({
        range: `custom_upload_${key}_${data.numbers[0]}`,
        count: data.numbers.length,
        panel: 'Admin Upload'
      });
    }

    // Merge panel ranges if mapping exists
    if (panelManager.hasMappingForApp(appId)) {
      try {
        const panelRanges = await panelManager.getAvailableRangesForApp(appId);
        ranges.push(...panelRanges);
      } catch (e) {
        console.error('Error fetching panel ranges:', e.message);
      }
    }

    if (ranges.length === 0) {
      await this._safeEdit(userId, messageId,
        `❌ *No numbers available for this app!*\n` +
        `📦 App: ${appName}\n`,
        {
          parse_mode: 'Markdown',
          reply_markup: { inline_keyboard: this._getAppMenuKeyboard(userId) }
        }
      );
      return;
    }

    // Loading text removed to ensure smooth transitions without flickers

    try {
      // ---- Country অনুযায়ী group করো ----
      const countryGroups = new Map();

      for (const r of ranges) {
        let cInfo;
        if (r.panel === 'Admin Upload') {
          // It's a custom range, we extract details directly
          const phone = r.range.split('_').pop();
          const info = this._getCountryInfo(phone);
          const countryName = info && info.name !== 'Unknown' ? info.name : 'Custom';
          const flag = info ? info.flag : '🌐';
          cInfo = {
            flag: flag,
            displayName: countryName,
            key: countryName.toLowerCase().replace(/\s+/g, '_')
          };
        } else {
          cInfo = this._extractCountryFromRange(r.range);
        }

        const key = cInfo.key;

        if (!countryGroups.has(key)) {
          countryGroups.set(key, {
            flag: cInfo.flag,
            displayName: cInfo.displayName,
            ranges: [],
            totalCount: 0
          });
        }

        countryGroups.get(key).ranges.push({ range: r.range, count: r.count, panel: r.panel });
        countryGroups.get(key).totalCount += r.count;
      }

      // Sort by total count (বেশি → আগে)
      const groups = Array.from(countryGroups.values()).sort((a, b) => b.totalCount - a.totalCount);

      // State-এ store করো (callback-এ ব্যবহারের জন্য)
      this._countrySelectState.set(userId, { appId, groups });

      // ---- Country buttons তৈরি ----
      let text = `✅ *${appName}* — Select a Country\n\n`;
      text += `📱 Select a country from below:\n`;
      text += `Click on the country whose numbers you need:\n`;

      const countryButtons = [];
      for (let i = 0; i < groups.length; i++) {
        const g = groups[i];
        const btnLabel = `${g.flag} ${g.displayName} (${g.totalCount})`;
        const cbData = `cr_${i}`;
        countryButtons.push([{ text: btnLabel, callback_data: cbData }]);
      }

      countryButtons.push(
        [{ text: '📱 Select Another App', callback_data: 'main_menu' }]
      );

      await this._safeEdit(userId, messageId, text, {
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: countryButtons }
      });

    } catch (error) {
      console.error(`Error showing country buttons for ${appId}: ${error.message}`);
      await this._safeEdit(userId, messageId,
        `❌ *Error!*\n\nProblem loading country list. Please try again.`,
        {
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [
              [{ text: '🔄 Try Again', callback_data: `app_${appId}` }],
              [{ text: '🏠 Main Menu', callback_data: 'main_menu' }]
            ]
          }
        }
      );
    }
  }



  /**
   * Country button click → confirmation screen দেখাও
   * "Get Numbers" button সহ country info দেখায়
   */
  async _showCountryConfirm(userId, groupIndex, messageId) {
    const state = this._countrySelectState.get(userId);
    if (!state || !state.groups[groupIndex]) {
      await this._safeEdit(userId, messageId,
        '📱 *Which app do you need OTP for?* Select from below:',
        { parse_mode: 'Markdown', reply_markup: { inline_keyboard: this._getAppMenuKeyboard(userId) } }
      );
      return;
    }

    const group = state.groups[groupIndex];
    const appId = state.appId;
    const app = config.SUPPORTED_APPS.find(a => a.id === appId);
    const appName = app ? app.name : appId;

    // selected group index store করো
    this._countrySelectState.set(userId, {
      ...state,
      selectedIndex: groupIndex
    });

    // Range details (প্যানেল ও range name)
    let rangeDetails = '';
    for (const r of group.ranges) {
      const safeRange = this._escapeMd(r.range);
      rangeDetails += `  • ${safeRange} (${r.count})\n`;
    }

    const confirmText =
      `📦 *${appName}*\n\n` +
      `${group.flag} *${group.displayName}*\n` +
      `📱 Available numbers: *${group.totalCount}*\n\n` +
      `Click the button below to get numbers ↓`;

    const confirmButtons = [
      [{ text: `📱 Get Numbers (${group.totalCount})`, callback_data: 'gn_' }],
      [{ text: '🔙 Back to Country List', callback_data: `app_${appId}` }],
      [{ text: '🏠 Main Menu', callback_data: 'main_menu' }]
    ];

    await this._safeEdit(userId, messageId, confirmText, {
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: confirmButtons }
    });
  }

  /**
   * "Get Numbers" button click handler
   * সেই country এর সব range থেকে নাম্বার এনে দেখায়
   */
  async _handleCountrySelect(userId, messageId = null) {
    const state = this._countrySelectState.get(userId);
    if (!state || state.selectedIndex === undefined) {
      await this._safeSend(userId, '📱 *Which app do you need OTP for?* Select from below:', {
        parse_mode: 'Markdown', reply_markup: { inline_keyboard: this._getAppMenuKeyboard(userId) }
      });
      return;
    }

    const groupIndex = state.selectedIndex;

    const group = state.groups[groupIndex];
    const appId = state.appId;
    const app = config.SUPPORTED_APPS.find(a => a.id === appId);
    const appName = app ? app.name : appId;
    const countryDisplay = `${group.flag} ${group.displayName}`;

    console.log(`[REQUEST] Numbers for user ${userId}, app ${appId}, country: ${group.displayName} (${group.ranges.length} ranges)`);

    let loadingMsg;
    if (messageId) {
      loadingMsg = { message_id: messageId };
      // No edit here to ensure smooth transition
    } else {
      loadingMsg = await this._safeSend(userId,
        `⏳ *${appName}* (${countryDisplay})\n\n` +
        `🔄 Fetching numbers, please wait...`,
        { parse_mode: 'Markdown' }
      );
      if (!loadingMsg) return;
    }

    try {
      // সব range থেকে নাম্বার সংগ্রহ
      const allNumbers = [];
      for (const rangeInfo of group.ranges) {
        if (rangeInfo.panel === 'Admin Upload') {
          const db = require('../database');
          const dbNums = db.prepare('SELECT phone_number FROM custom_numbers WHERE app_id = ? AND is_used = 0').all(appId);
          const matchedNums = dbNums.filter(n => {
            const cInfo = this._getCountryInfo(n.phone_number);
            return (cInfo && cInfo.name !== 'Unknown' ? cInfo.name : 'Custom') === group.displayName;
          });

          allNumbers.push(...matchedNums.map(n => ({
            number: n.phone_number,
            panel: 'Admin Upload',
            payout: ''
          })));
        } else {
          try {
            const nums = await panelManager.getNumbersForApp(appId, rangeInfo.range);
            allNumbers.push(...nums);
          } catch (err) {
            console.error(`[PanelManager] Error fetching from range ${rangeInfo.range}: ${err.message}`);
          }
        }
      }

      // Prioritize Admin Upload numbers
      allNumbers.sort((a, b) => {
        if (a.panel === 'Admin Upload' && b.panel !== 'Admin Upload') return -1;
        if (a.panel !== 'Admin Upload' && b.panel === 'Admin Upload') return 1;
        return 0;
      });

      if (allNumbers.length === 0) {
        await this._safeEdit(userId, loadingMsg.message_id,
          `❌ *Sorry, no numbers available right now!*\n\n` +
          `📦 App: ${appName}\n` +
          `🌍 Country: ${countryDisplay}\n\n`,
          {
            parse_mode: 'Markdown',
            reply_markup: {
              inline_keyboard: [
                [{ text: '🔄 Try Again', callback_data: `app_${appId}` }],
                [{ text: '📱 Select Another App', callback_data: 'main_menu' }]
              ]
            }
          }
        );
        return;
      }

      const allocated = numberManager.allocateNumbers(userId, appId, allNumbers, this.token);

      if (allocated.length === 0) {
        await this._safeEdit(userId, loadingMsg.message_id,
          `⚠️ *All numbers are in use!*\n\n` +
          `📦 App: ${appName}\n` +
          `🌍 Country: ${countryDisplay}\n\n`,
          {
            parse_mode: 'Markdown',
            reply_markup: {
              inline_keyboard: [
                [{ text: '🔄 Try Again', callback_data: `app_${appId}` }],
                [{ text: '📱 Select Another App', callback_data: 'main_menu' }]
              ]
            }
          }
        );
        return;
      }

      // Mark allocated custom numbers as used
      const db = require('../database');
      const updateStmt = db.prepare('UPDATE custom_numbers SET is_used = 1 WHERE app_id = ? AND phone_number = ?');
      for (const num of allocated) {
        if (num.panel === 'Admin Upload') {
          updateStmt.run(appId, num.number);
        }
      }

      const countryInfo = this._getCountryInfo(allocated[0]?.number || '');
      const flag = countryInfo ? countryInfo.flag : (group ? group.flag : '🌐');

      let numbersText = `${flag} *${appName}*\n\n` +
        `💰 Price: $0.00001 USDT\n\n` +
        `Select a number to copy:`;

      const inlineKeyboard = [];
      allocated.forEach((num) => {
        const nFlag = this._getCountryInfo(num.number)?.flag || flag;
        inlineKeyboard.push([{
          text: `📋 ${nFlag} +${num.number.replace(/^\+/, '')}`,
          copy_text: { text: num.number }
        }]);
      });

      inlineKeyboard.push([
        { text: '🔄 Change', callback_data: `change_num_${appId}` },
        { text: '📨 OTP', url: config.OTP_GROUP_LINK }
      ]);
      inlineKeyboard.push([{ text: '⬅️ Back', callback_data: 'main_menu' }]);

      await this._safeEdit(userId, loadingMsg.message_id, numbersText, {
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: inlineKeyboard }
      });

    } catch (error) {
      console.error(`Error requesting numbers for ${userId}: ${error.message}`);
      await this._safeEdit(userId, loadingMsg.message_id,
        `❌ *Error!*\n\nProblem fetching numbers. Please try again.`,
        {
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [
              [{ text: '🔄 Try Again', callback_data: 'main_menu' }],
              [{ text: '📊 Status', callback_data: 'refresh_status' }]
            ]
          }
        }
      );
    }
  }



  // ============================================================
  // CORE FUNCTIONS — Number Request
  // ============================================================

  async _requestNumbers(userId, appId, specificRange = null, messageId = null) {
    const app = config.SUPPORTED_APPS.find(a => a.id === appId);
    const appName = app ? app.name : appId;

    console.log(`[REQUEST] Numbers for user ${userId}, app ${appId}, range: ${specificRange || 'all'}`);

    let loadingMsg;
    if (messageId) {
      // No loading text, just edit the numbers when they arrive
      loadingMsg = { message_id: messageId };
    } else {
      loadingMsg = await this._safeSend(userId,
        `⏳ *${appName}* — Searching for numbers...\n\n` +
        `🔄 Fetching numbers, please wait...`,
        { parse_mode: 'Markdown' }
      );
      if (!loadingMsg) return;
    }

    try {
      const allNumbers = [];
      const db = require('../database');

      if (specificRange && specificRange.startsWith('custom_upload_')) {
        const parts = specificRange.split('_');
        const countryKey = parts[2];
        const dbNums = db.prepare('SELECT phone_number FROM custom_numbers WHERE app_id = ? AND is_used = 0').all(appId);
        const matchedNums = dbNums.filter(n => {
          const cInfo = this._getCountryInfo(n.phone_number);
          const nameKey = (cInfo && cInfo.name !== 'Unknown' ? cInfo.name : 'Custom').toLowerCase().replace(/\s+/g, '_');
          return nameKey === countryKey;
        });
        allNumbers.push(...matchedNums.map(n => ({
          number: n.phone_number,
          panel: 'Admin Upload',
          payout: ''
        })));
      } else {
        // Fetch custom numbers first
        const dbNums = db.prepare('SELECT phone_number FROM custom_numbers WHERE app_id = ? AND is_used = 0').all(appId);
        allNumbers.push(...dbNums.map(n => ({
          number: n.phone_number,
          panel: 'Admin Upload',
          payout: ''
        })));

        if (panelManager.hasMappingForApp(appId)) {
          try {
            const nums = await panelManager.getNumbersForApp(appId, specificRange);
            allNumbers.push(...nums);
          } catch (err) {
            console.error(`Error fetching panel numbers: ${err.message}`);
          }
        }
      }

      // Prioritize Admin Upload
      allNumbers.sort((a, b) => {
        if (a.panel === 'Admin Upload' && b.panel !== 'Admin Upload') return -1;
        if (a.panel !== 'Admin Upload' && b.panel === 'Admin Upload') return 1;
        return 0;
      });

      if (allNumbers.length === 0) {
        await this._safeEdit(userId, loadingMsg.message_id,
          `❌ *Sorry, no numbers available right now!*\n\n` +
          `📦 App: ${appName}\n\n` +
          `No numbers available.\n` +
          `Please try again later.`,
          {
            parse_mode: 'Markdown',
            reply_markup: {
              inline_keyboard: [
                [{ text: '🔄 Try Again', callback_data: `app_${appId}` }],
                [{ text: '📱 Select Another App', callback_data: 'main_menu' }]
              ]
            }
          }
        );
        return;
      }

      const allocated = numberManager.allocateNumbers(userId, appId, allNumbers, this.token);

      if (allocated.length === 0) {
        await this._safeEdit(userId, loadingMsg.message_id,
          `⚠️ *All numbers are in use!*\n\n` +
          `📦 App: ${appName}\n\n` +
          `All numbers are currently being used by someone else.\n` +
          `Please try again later.`,
          {
            parse_mode: 'Markdown',
            reply_markup: {
              inline_keyboard: [
                [{ text: '🔄 Try Again', callback_data: `app_${appId}` }],
                [{ text: '📱 Select Another App', callback_data: 'main_menu' }]
              ]
            }
          }
        );
        return;
      }

      // Mark allocated custom numbers as used
      const updateStmt = db.prepare('UPDATE custom_numbers SET is_used = 1 WHERE app_id = ? AND phone_number = ?');
      for (const num of allocated) {
        if (num.panel === 'Admin Upload') {
          updateStmt.run(appId, num.number);
        }
      }

      const firstFlag = this._getCountryInfo(allocated[0]?.number || '')?.flag || '🌐';

      let numbersText = `${firstFlag} *${appName}*\n\n` +
        `💰 Price: $0.00001 USDT\n\n` +
        `Select a number to copy:`;

      const inlineKeyboard = [];
      allocated.forEach((num) => {
        const nFlag = this._getCountryInfo(num.number)?.flag || '🌐';
        inlineKeyboard.push([{
          text: `📋 ${nFlag} +${num.number.replace(/^\+/, '')}`,
          copy_text: { text: num.number }
        }]);
      });

      inlineKeyboard.push([
        { text: '🔄 Change', callback_data: `change_num_${appId}` },
        { text: '📨 OTP', url: config.OTP_GROUP_LINK }
      ]);
      inlineKeyboard.push([{ text: '⬅️ Back', callback_data: 'main_menu' }]);

      await this._safeEdit(userId, loadingMsg.message_id, numbersText, {
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: inlineKeyboard }
      });

    } catch (error) {
      console.error(`Error requesting numbers for ${userId}: ${error.message}`);

      await this._safeEdit(userId, loadingMsg.message_id,
        `❌ *Error!*\n\nProblem fetching numbers. Please try again.`,
        {
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [
              [{ text: '🔄 Try Again', callback_data: 'main_menu' }],
              [{ text: '📊 Status', callback_data: 'refresh_status' }]
            ]
          }
        }
      );
    }
  }



  // ============================================================
  // SINGLE NUMBER REQUEST
  // ============================================================

  async _requestSingleNumber(userId, appId, messageId) {
    const app = config.SUPPORTED_APPS.find(a => a.id === appId);
    const appName = app ? app.name : appId;

    try {
      const availableNumbers = await panelManager.getNumbersForApp(appId);

      if (availableNumbers.length === 0) {
        await this._safeSend(userId,
          `❌ No new numbers available right now. Please try again later.`,
          { parse_mode: 'Markdown' }
        );
        return;
      }

      const allocated = numberManager.allocateNumbers(userId, appId, availableNumbers, this.token);

      if (allocated.length === 0) {
        await this._safeSend(userId,
          `⚠️ All numbers are in use! Please try again later.`,
          { parse_mode: 'Markdown' }
        );
        return;
      }

      const num = allocated[0];
      const payout = num.payout ? num.payout : '$ 0.00';

      const newText = `🆕 *New number found!*

` +
        `📱 Number: \`${num.number}\`  💰 ${payout}
` +
        `📦 App: ${appName}
` +
        `⏳ Checking for OTP in real-time...`;

      const buttons = [
        [{ text: '📱 Need More Numbers', callback_data: `app_${appId}` }],
        [{ text: '🏠 Main Menu', callback_data: 'main_menu' }]
      ];

      await this._safeSend(userId, newText, {
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: buttons }
      });

    } catch (error) {
      console.error(`Error getting single number: ${error.message}`);
      await this._safeSend(userId, '❌ Problem fetching a new number.',
        { parse_mode: 'Markdown' }
      );
    }
  }

  // ============================================================
  // RANGE ADD v8 — App → Panel → Range → Instant Add
  // ============================================================
  //
  // নতুন ফ্লো:
  // ১. admin "Range Add" ক্লিক করলে → panel inventory দেখাবে + app buttons
  // ২. admin একটি app সিলেক্ট করলে → panel buttons দেখাবে
  // ৩. admin একটি panel সিলেক্ট করলে → available ranges buttons দেখাবে
  // ৪. admin একটি range ক্লিক করলে → সাথে সাথে mapping সেভ হবে
  //
  // Range গুলো "My Numbers" পেজের range column থেকে আসে
  // ============================================================

  /**
   * ধাপ ১: Range Add শুরু
   * Panel inventory দেখাও (my numbers range column থেকে)
   * এবং App buttons দেখাও (কোন অ্যাপের জন্য range add করতে চান)
   */
  async _startRangeAdd(userId, messageId) {
    await this._safeEdit(userId, messageId,
      '🔄 Fetching ranges from all panels...\n\n⏳ Please wait...',
      { parse_mode: 'Markdown' }
    );

    try {
      const allRanges = await panelManager.getAllRanges();

      // ---- Panel Inventory ----
      const panelStatuses = panelManager.getStatus();
      let inventoryText = '📊 *Panel Inventory*\n';
      inventoryText += '(From the Range column on the My Numbers page)\n\n';

      let totalRanges = 0;
      const activePanels = []; // { idx, name, rangeCount }

      for (let i = 0; i < config.PANELS.length; i++) {
        const panelConfig = config.PANELS[i];
        if (!panelConfig.enabled) continue;

        const status = panelStatuses.find(s => s.name === panelConfig.name);
        const isLoggedIn = status && status.isLoggedIn;
        const ranges = allRanges[panelConfig.name] || [];

        const icon = isLoggedIn ? '🟢' : '🔴';
        const countStr = isLoggedIn ? `${ranges.length} ranges` : 'Not logged in';

        inventoryText += `${icon} *${this._escapeMd(panelConfig.name)}*: ${countStr}\n`;

        if (isLoggedIn && ranges.length > 0) {
          totalRanges += ranges.length;
          activePanels.push({ idx: i, name: panelConfig.name, rangeCount: ranges.length });

          // প্রতিটি range এর নাম ও count (সর্বোচ্চ 15টি)
          const showRanges = ranges.slice(0, 15);
          for (const r of showRanges) {
            inventoryText += `   • ${this._escapeMd(r.range)} (${r.count})\n`;
          }
          if (ranges.length > 15) {
            inventoryText += `   ... and ${ranges.length - 15} more\n`;
          }
        }
        inventoryText += '\n';
      }

      inventoryText += `📈 Total: ${totalRanges} ranges\n`;

      // ---- App Selection Buttons ----
      inventoryText += `\n📦 *Which app do you want to add ranges for?*\n`;
      inventoryText += `Select an app from below:`;

      const appButtons = [];
      for (const app of config.SUPPORTED_APPS) {
        appButtons.push([{ text: app.name, callback_data: `ra_app:${app.id}` }]);
      }

      appButtons.push(
        [{ text: '📋 View Mapping', callback_data: 'admin_view_mapping' }],
        [{ text: '❌ Cancel', callback_data: 'ra_cancel' }]
      );

      await this._safeEdit(userId, messageId, inventoryText, {
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: appButtons }
      });

      // State সেভ (ranges data সহ, পরবর্তী ধাপে ব্যবহৃত হবে)
      this._rangeAddState.set(userId, {
        step: 'select_app',
        allRanges: allRanges
      });

    } catch (error) {
      console.error(`[RangeAdd] Error fetching ranges: ${error.message}`);
      await this._safeEdit(userId, messageId,
        '❌ Problem fetching ranges. Please try again.',
        {
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [
              [{ text: '🔄 Try Again', callback_data: 'admin_range_add' }],
              [{ text: '🏠 Main Menu', callback_data: 'main_menu' }]
            ]
          }
        }
      );
    }
  }

  /**
   * ধাপ ২: App সিলেক্ট হয়েছে
   * এখন কোন প্যানেল থেকে range add করবে তা দেখাও
   */
  async _handleRangeAppSelect(userId, appId, messageId) {
    const state = this._rangeAddState.get(userId);
    if (!state) {
      await this._startRangeAdd(userId, messageId);
      return;
    }

    const app = config.SUPPORTED_APPS.find(a => a.id === appId);
    if (!app) {
      await this._safeEdit(userId, messageId, '❌ App not found.',
        { reply_markup: { inline_keyboard: [[{ text: '🔙', callback_data: 'ra_back_apps' }]] } }
      );
      return;
    }

    const appName = app.name;
    const allRanges = state.allRanges;

    // State আপডেট — appId সেভ
    state.step = 'select_panel';
    state.appId = appId;

    // কোন প্যানেলে range আছে তা দেখাও
    const panelStatuses = panelManager.getStatus();
    const panelButtons = [];

    let text = `📦 *${appName}* — Select a Panel\n\n`;
    text += `Which panel do you want to add ranges from?\n\n`;

    for (let i = 0; i < config.PANELS.length; i++) {
      const panelConfig = config.PANELS[i];
      if (!panelConfig.enabled) continue;

      const status = panelStatuses.find(s => s.name === panelConfig.name);
      const isLoggedIn = status && status.isLoggedIn;
      const ranges = allRanges[panelConfig.name] || [];

      if (isLoggedIn && ranges.length > 0) {
        text += `🖥️ *${this._escapeMd(panelConfig.name)}*: ${ranges.length} ranges available\n`;
        panelButtons.push([{ text: `🖥️ ${panelConfig.name} (${ranges.length} ranges)`, callback_data: `ra_panel:${i}` }]);
      } else if (isLoggedIn) {
        text += `🖥️ *${this._escapeMd(panelConfig.name)}*: ❌ No ranges available\n`;
      } else {
        text += `🖥️ *${this._escapeMd(panelConfig.name)}*: ⚠️ Not logged in\n`;
      }
    }

    panelButtons.push(
      [{ text: '🔙 Back to App List', callback_data: 'ra_back_apps' }],
      [{ text: '❌ Cancel', callback_data: 'ra_cancel' }]
    );

    await this._safeEdit(userId, messageId, text, {
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: panelButtons }
    });
  }

  /**
   * ধাপ ৩: Panel সিলেক্ট হয়েছে
   * এখন ঐ প্যানেলে available ranges গুলো button আকারে দেখাও
   * (My Numbers এর Range কলাম থেকে)
   */
  async _handleRangePanelSelect(userId, panelIdx, messageId) {
    const state = this._rangeAddState.get(userId);
    if (!state || !state.appId) {
      await this._startRangeAdd(userId, messageId);
      return;
    }

    const panelConfig = config.PANELS[panelIdx];
    if (!panelConfig) {
      await this._safeEdit(userId, messageId, '❌ Panel not found.',
        { reply_markup: { inline_keyboard: [[{ text: '🔙', callback_data: 'ra_back_apps' }]] } }
      );
      return;
    }

    const app = config.SUPPORTED_APPS.find(a => a.id === state.appId);
    const appName = app ? app.name : state.appId;

    const allRanges = state.allRanges;
    const ranges = (allRanges[panelConfig.name] || []).slice(0, 40);

    if (ranges.length === 0) {
      await this._safeEdit(userId, messageId,
        `❌ No ranges available on *${panelConfig.name}* panel.\n\nPlease select another panel.`,
        {
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [
              [{ text: '🔙 Back to Panel List', callback_data: 'ra_back_panels' }],
              [{ text: '❌ Cancel', callback_data: 'ra_cancel' }]
            ]
          }
        }
      );
      return;
    }

    // State আপডেট
    state.step = 'select_range';
    state.panelIdx = panelIdx;
    state.panelName = panelConfig.name;

    // ইতিমধ্যে mapped ranges চেক করা
    const existingMappings = config.APP_NUMBER_MAPPING[state.appId] || [];
    const mappedRangesForThisPanel = existingMappings
      .filter(m => m.panel === panelConfig.name)
      .map(m => m.range.toLowerCase());

    let text = `📦 *${appName}*\n`;
    text += `🖥️ *${this._escapeMd(panelConfig.name)}* — Select a Range\n\n`;
    text += `Found ${ranges.length} ranges.\n`;
    text += `Click on any range to add it instantly!\n\n`;

    const rangeButtons = [];

    for (let i = 0; i < ranges.length; i++) {
      const r = ranges[i];
      const isAlreadyMapped = mappedRangesForThisPanel.some(
        existing => r.range.toLowerCase().includes(existing) || existing.includes(r.range.toLowerCase())
      );
      const indicator = isAlreadyMapped ? '✅ ' : '';
      rangeButtons.push([{
        text: `${indicator}📋 ${r.range} (${r.count})`,
        callback_data: `ra_range:${i}`
      }]);
    }

    if (ranges.length > 40) {
      text += `(Showing first 40)\n`;
    }

    rangeButtons.push(
      [{ text: '🔙 Back to Panel List', callback_data: 'ra_back_panels' }],
      [{ text: '🔙 Back to App List', callback_data: 'ra_back_apps' }],
      [{ text: '❌ Cancel', callback_data: 'ra_cancel' }]
    );

    await this._safeEdit(userId, messageId, text, {
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: rangeButtons }
    });
  }

  /**
   * Back to Panel list (from range list)
   * appId state থেকে পড়বে
   */
  async _handleRangeBackToPanels(userId, messageId) {
    const state = this._rangeAddState.get(userId);
    if (!state || !state.appId) {
      await this._startRangeAdd(userId, messageId);
      return;
    }
    // আবার panel select step এ ফিরে যাই
    await this._handleRangeAppSelect(userId, state.appId, messageId);
  }

  /**
   * ধাপ ৪: Range ক্লিক → সাথে সাথে Mapping সেভ!
   */
  async _handleRangeInstantAdd(userId, rangeIdx, messageId) {
    const state = this._rangeAddState.get(userId);
    if (!state || !state.appId || !state.panelName) {
      await this._startRangeAdd(userId, messageId);
      return;
    }

    const appId = state.appId;
    const panelName = state.panelName;
    const app = config.SUPPORTED_APPS.find(a => a.id === appId);
    const appName = app ? app.name : appId;

    const allRanges = state.allRanges;
    const ranges = (allRanges[panelName] || []);
    const selectedRange = ranges[rangeIdx];

    if (!selectedRange) {
      await this._safeEdit(userId, messageId, '❌ Range not found.',
        { reply_markup: { inline_keyboard: [[{ text: '🔙', callback_data: 'ra_back_panels' }]] } }
      );
      return;
    }

    const rangeName = selectedRange.range;

    // Mapping সেভ
    const newMapping = { panel: panelName, range: rangeName };

    if (!config.APP_NUMBER_MAPPING[appId]) {
      config.APP_NUMBER_MAPPING[appId] = [];
    }

    // ডুপ্লিকেট চেক
    const exists = config.APP_NUMBER_MAPPING[appId].some(
      m => m.panel === panelName && m.range.toLowerCase() === rangeName.toLowerCase()
    );

    const panelButtons = [];
    // ঐ panel এ আরো range আছে কিনা দেখাও
    for (let i = 0; i < ranges.length; i++) {
      panelButtons.push([{
        text: `📋 ${ranges[i].range} (${ranges[i].count})`,
        callback_data: `ra_range:${i}`
      }]);
    }

    if (exists) {
      console.log(`[RANGE_ADD] Duplicate: ${panelName} + "${rangeName}" → ${appId}`);

      await this._safeEdit(userId, messageId,
        `⚠️ *This mapping already exists!*\n\n` +
        `📦 App: ${appName}\n` +
        `🖥️ Panel: ${this._escapeMd(panelName)}\n` +
        `📋 Range: ${this._escapeMd(rangeName)}\n\n` +
        `This would be a duplicate, so it was not added again.\n` +
        `Select another range:`,
        {
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [
              ...panelButtons.slice(0, 20),
              [{ text: '🔙 Back to Panel List', callback_data: 'ra_back_panels' }],
              [{ text: '❌ Cancel', callback_data: 'ra_cancel' }]
            ]
          }
        }
      );
      return;
    }

    // সেভ করা হলো!
    config.APP_NUMBER_MAPPING[appId].push(newMapping);

    console.log(`[RANGE_ADD] Saved: ${panelName} + "${rangeName}" → ${appId} (${selectedRange.count} numbers)`);

    // আপডেটেড range list দেখাও (already mapped indicator সহ)
    const updatedMappings = config.APP_NUMBER_MAPPING[appId];
    const mappedForPanel = updatedMappings
      .filter(m => m.panel === panelName)
      .map(m => m.range.toLowerCase());

    const updatedButtons = [];
    for (let i = 0; i < ranges.length; i++) {
      const r = ranges[i];
      const isMapped = mappedForPanel.some(
        existing => r.range.toLowerCase().includes(existing) || existing.includes(r.range.toLowerCase())
      );
      const indicator = isMapped ? '✅ ' : '';
      updatedButtons.push([{
        text: `${indicator}📋 ${r.range} (${r.count})`,
        callback_data: `ra_range:${i}`
      }]);
    }

    await this._safeEdit(userId, messageId,
      `✅ *Range added!*\n\n` +
      `📦 App: *${appName}*\n` +
      `🖥️ Panel: *${this._escapeMd(panelName)}*\n` +
      `📋 Range: *${this._escapeMd(rangeName)}* (${selectedRange.count} numbers)\n\n` +
      `✅ From now on, numbers from the "${this._escapeMd(rangeName)}" range will be used for ${appName}.\n\n` +
      `To add more ranges, select from below:`,
      {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            ...updatedButtons.slice(0, 20),
            [{ text: '🔙 Back to Panel List', callback_data: 'ra_back_panels' }],
            [{ text: '🔙 Back to App List', callback_data: 'ra_back_apps' }],
            [{ text: '📋 View Mapping', callback_data: 'admin_view_mapping' }],
            [{ text: '❌ Cancel', callback_data: 'ra_cancel' }]
          ]
        }
      }
    );

    // State রাখি — একই panel এ আরো range add করতে পারবে
  }

  // ============================================================
  // MAPPING VIEW / DELETE
  // ============================================================

  /**
   * বর্তমান APP_NUMBER_MAPPING দেখাও
   */
  async _showCurrentMapping(userId, messageId) {
    let text = '📋 *Current Range Mapping*\n\n';

    let hasAny = false;

    for (const app of config.SUPPORTED_APPS) {
      const mappings = config.APP_NUMBER_MAPPING[app.id] || [];

      text += `*${app.name}*\n`;

      if (mappings.length === 0) {
        text += `   ❌ No mappings\n`;
      } else {
        hasAny = true;
        mappings.forEach((m, idx) => {
          text += `   ${idx + 1}. ${this._escapeMd(m.panel)} → ${this._escapeMd(m.range)}\n`;
        });
      }
      text += '\n';
    }

    if (!hasAny) {
      text += '⚠️ No mappings have been added yet.\n';
      text += '➕ Click the Range Add button to add mappings.\n';
    }

    const deleteButtons = [];
    for (const app of config.SUPPORTED_APPS) {
      const mappings = config.APP_NUMBER_MAPPING[app.id] || [];
      for (let i = 0; i < mappings.length; i++) {
        const m = mappings[i];
        deleteButtons.push([{
          text: `❌ ${app.name}: ${m.panel} → ${m.range}`,
          callback_data: `delmap:${app.id}:${i}`
        }]);
      }
    }

    deleteButtons.push(
      [{ text: '➕ Add New Range', callback_data: 'admin_range_add' }],
      [{ text: '🏠 Main Menu', callback_data: 'main_menu' }]
    );

    await this._safeEdit(userId, messageId, text, {
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: deleteButtons }
    });
  }

  /**
   * Mapping entry ডিলিট
   */
  async _deleteMappingEntry(userId, appId, idx, messageId) {
    const app = config.SUPPORTED_APPS.find(a => a.id === appId);
    const appName = app ? app.name : appId;
    const mappings = config.APP_NUMBER_MAPPING[appId];

    if (!mappings || !mappings[idx]) {
      await this._safeAnswer(undefined, '❌ Not found');
      return;
    }

    const removed = mappings.splice(idx, 1)[0];
    console.log(`[RANGE_DEL] Removed: ${removed.panel} + "${removed.range}" → ${appId}`);

    await this._safeSend(userId,
      `✅ Mapping deleted:\n\n` +
      `📦 ${appName}\n` +
      `🖥️ ${this._escapeMd(removed.panel)} → ${this._escapeMd(removed.range)}`,
      { parse_mode: 'Markdown' }
    );

    await this._showCurrentMapping(userId, messageId);
  }

  // ============================================================
  // TEXT MESSAGE HANDLER
  // ============================================================

  async _handleTextMessage(msg) {
    const userId = msg.from.id;
    const text = (msg.text || '').trim();

    if (!text) return;

    // Check if adding panel state
    const addPanelState = this._addPanelState.get(userId);
    if (addPanelState) {
      if (!this._isAdmin(userId)) return;
      await this._handleAddPanelInput(userId, text, msg.message_id);
      return;
    }

    const state = this._rangeAddState.get(userId);
    if (!state) return;
    if (!this._isAdmin(userId)) return;

    // Format: panel_name, range_name, app_id
    const parts = text.split(',').map(s => s.trim()).filter(s => s.length > 0);

    if (parts.length < 3) {
      await this._safeSend(userId,
        `⚠️ *Wrong format!*\n\n` +
        `Correct format:\n\`Panel Name, Range Name, App Name\`\n\n` +
        `Example:\n\`Wolf SMS, Russia, whatsapp\`\n\`SMS Hub, India, facebook\`\n\n` +
        `Available App IDs: ${config.SUPPORTED_APPS.map(a => a.id).join(', ')}`,
        { parse_mode: 'Markdown' }
      );
      return;
    }

    const panelName = parts[0];
    const rangeName = parts[1];
    const appNameInput = parts.slice(2).join(' ').toLowerCase();

    // App ID খোঁজা
    const matchedApp = config.SUPPORTED_APPS.find(
      a => a.id === appNameInput || a.name.toLowerCase() === appNameInput
    );

    if (!matchedApp) {
      await this._safeSend(userId,
        `⚠️ *App not found: "${this._escapeMd(appNameInput)}"*\n\n` +
        `Please use a valid App ID:\n` +
        config.SUPPORTED_APPS.map(a => `• ${a.id}`).join('\n'),
        { parse_mode: 'Markdown' }
      );
      return;
    }

    // Panel validate
    const exactPanel = config.PANELS.find(p => p.name.toLowerCase() === panelName.toLowerCase());
    if (!exactPanel) {
      await this._safeSend(userId,
        `⚠️ *Panel not found: "${this._escapeMd(panelName)}"*\n\n` +
        `Valid panel names:\n` +
        config.PANELS.map(p => `• ${this._escapeMd(p.name)}`).join('\n'),
        { parse_mode: 'Markdown' }
      );
      return;
    }

    // Save mapping
    const newMapping = { panel: exactPanel.name, range: rangeName };
    if (!config.APP_NUMBER_MAPPING[matchedApp.id]) {
      config.APP_NUMBER_MAPPING[matchedApp.id] = [];
    }

    // Duplicate check
    const exists = config.APP_NUMBER_MAPPING[matchedApp.id].some(
      m => m.panel.toLowerCase() === exactPanel.name.toLowerCase() &&
        m.range.toLowerCase() === rangeName.toLowerCase()
    );

    if (exists) {
      await this._safeSend(userId,
        `⚠️ This mapping already exists!\n\n` +
        `${this._escapeMd(exactPanel.name)} + "${this._escapeMd(rangeName)}" → ${matchedApp.emoji} ${matchedApp.name}`,
        { parse_mode: 'Markdown' }
      );
      return;
    }

    config.APP_NUMBER_MAPPING[matchedApp.id].push(newMapping);

    console.log(`[RANGE_ADD] Saved (text input): ${exactPanel.name} + "${rangeName}" → ${matchedApp.id}`);

    this._rangeAddState.delete(userId);

    await this._safeSend(userId,
      `✅ *Range Mapping Added!*\n\n` +
      `🖥️ Panel: *${this._escapeMd(exactPanel.name)}*\n` +
      `📋 Range: *${this._escapeMd(rangeName)}*\n` +
      `📦 App: *${matchedApp.emoji} ${matchedApp.name}*\n\n` +
      `From now on, numbers from the "${this._escapeMd(rangeName)}" range on the ${this._escapeMd(exactPanel.name)} panel will be used for ${matchedApp.emoji} ${matchedApp.name}.`,
      {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [{ text: '➕ Add Another', callback_data: 'admin_range_add' }],
            [{ text: '📋 View Mapping', callback_data: 'admin_view_mapping' }],
            [{ text: '🏠 Main Menu', callback_data: 'main_menu' }]
          ]
        }
      }
    );
  }

  // ============================================================
  // HELPER FUNCTIONS
  // ============================================================

  /**
   * HTML escape — ডাইনামিক কন্টেন্টের জন্য
   * <, >, & ক্যারেক্টার escape করে (HTML parse_mode এর জন্য)
   */
  _escapeHtml(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  /**
   * Markdown escape — ডাইনামিক কন্টেন্টের জন্য (legacy Markdown)
   * Telegram legacy Markdown does NOT support backslash escape!
   * So we strip Markdown-special chars: * _ ` [ ]
   */
  _escapeMd(str) {
    if (!str) return '';
    return String(str).replace(/[*_`\[\]]/g, '');
  }

  /**
   * Range name থেকে country detect করো
   * keyword matching + phone prefix fallback
   * returns: { flag, displayName, key }
   */
  _extractCountryFromRange(rangeName) {
    const name = (rangeName || '').toLowerCase();

    const countryKeywords = [
      // Asia
      { flag: '🇧🇩', displayName: 'Bangladesh', keywords: ['bangladesh', 'bengal', 'bd'] },
      { flag: '🇮🇳', displayName: 'India', keywords: ['india', 'indien', 'bharat'] },
      { flag: '🇵🇰', displayName: 'Pakistan', keywords: ['pakistan'] },
      { flag: '🇷🇺', displayName: 'Russia', keywords: ['russia', 'russie', 'russian'] },
      { flag: '🇨🇳', displayName: 'China', keywords: ['china', 'chinese'] },
      { flag: '🇯🇵', displayName: 'Japan', keywords: ['japan', 'japanese'] },
      { flag: '🇰🇷', displayName: 'South Korea', keywords: ['south korea', 'korea'] },
      { flag: '🇹🇷', displayName: 'Turkey', keywords: ['turkey', 'turquie', 'turkiye'] },
      { flag: '🇮🇩', displayName: 'Indonesia', keywords: ['indonesia'] },
      { flag: '🇵🇭', displayName: 'Philippines', keywords: ['philippines', 'philippine'] },
      { flag: '🇹🇭', displayName: 'Thailand', keywords: ['thailand', 'thai'] },
      { flag: '🇻🇳', displayName: 'Vietnam', keywords: ['vietnam', 'viet'] },
      { flag: '🇲🇾', displayName: 'Malaysia', keywords: ['malaysia'] },
      { flag: '🇲🇲', displayName: 'Myanmar', keywords: ['myanmar', 'burma'] },
      { flag: '🇳🇵', displayName: 'Nepal', keywords: ['nepal'] },
      { flag: '🇱🇰', displayName: 'Sri Lanka', keywords: ['sri lanka'] },
      { flag: '🇦🇫', displayName: 'Afghanistan', keywords: ['afghanistan'] },
      { flag: '🇰🇭', displayName: 'Cambodia', keywords: ['cambodia'] },
      { flag: '🇱🇦', displayName: 'Laos', keywords: ['laos'] },
      { flag: '🇹🇯', displayName: 'Tajikistan', keywords: ['tajikistan', 'tajik'] },
      { flag: '🇺🇿', displayName: 'Uzbekistan', keywords: ['uzbekistan', 'uzbek'] },
      { flag: '🇰🇿', displayName: 'Kazakhstan', keywords: ['kazakhstan', 'kazakh'] },
      { flag: '🇦🇿', displayName: 'Azerbaijan', keywords: ['azerbaijan'] },
      { flag: '🇬🇪', displayName: 'Georgia', keywords: ['georgia'] },
      { flag: '🇦🇲', displayName: 'Armenia', keywords: ['armenia'] },
      { flag: '🇰🇬', displayName: 'Kyrgyzstan', keywords: ['kyrgyzstan', 'kyrgyz'] },
      { flag: '🇹🇲', displayName: 'Turkmenistan', keywords: ['turkmenistan'] },
      { flag: '🇲🇳', displayName: 'Mongolia', keywords: ['mongolia'] },
      { flag: '🇸🇬', displayName: 'Singapore', keywords: ['singapore'] },
      { flag: '🇧🇳', displayName: 'Brunei', keywords: ['brunei'] },
      { flag: '🇹🇱', displayName: 'Timor-Leste', keywords: ['timor', 'east timor'] },
      { flag: '🇵🇬', displayName: 'Papua New Guinea', keywords: ['papua'] },
      // Middle East
      { flag: '🇸🇦', displayName: 'Saudi Arabia', keywords: ['saudi', 'arabia'] },
      { flag: '🇦🇪', displayName: 'UAE', keywords: ['uae', 'emirates', 'dubai'] },
      { flag: '🇮🇶', displayName: 'Iraq', keywords: ['iraq'] },
      { flag: '🇮🇷', displayName: 'Iran', keywords: ['iran'] },
      { flag: '🇯🇴', displayName: 'Jordan', keywords: ['jordan'] },
      { flag: '🇱🇧', displayName: 'Lebanon', keywords: ['lebanon'] },
      { flag: '🇮🇱', displayName: 'Israel', keywords: ['israel'] },
      { flag: '🇾🇪', displayName: 'Yemen', keywords: ['yemen', 'yemeni'] },
      { flag: '🇴🇲', displayName: 'Oman', keywords: ['oman'] },
      { flag: '🇶🇦', displayName: 'Qatar', keywords: ['qatar'] },
      { flag: '🇰🇼', displayName: 'Kuwait', keywords: ['kuwait'] },
      { flag: '🇧🇭', displayName: 'Bahrain', keywords: ['bahrain'] },
      { flag: '🇸🇾', displayName: 'Syria', keywords: ['syria', 'syrian'] },
      { flag: '🇵🇸', displayName: 'Palestine', keywords: ['palestine', 'palestinian'] },
      // Europe
      { flag: '🇺🇦', displayName: 'Ukraine', keywords: ['ukraine'] },
      { flag: '🇵🇱', displayName: 'Poland', keywords: ['poland'] },
      { flag: '🇳🇱', displayName: 'Netherlands', keywords: ['netherlands', 'holland'] },
      { flag: '🇸🇪', displayName: 'Sweden', keywords: ['sweden'] },
      { flag: '🇳🇴', displayName: 'Norway', keywords: ['norway'] },
      { flag: '🇫🇮', displayName: 'Finland', keywords: ['finland'] },
      { flag: '🇩🇰', displayName: 'Denmark', keywords: ['denmark'] },
      { flag: '🇨🇿', displayName: 'Czech Republic', keywords: ['czech'] },
      { flag: '🇭🇺', displayName: 'Hungary', keywords: ['hungary'] },
      { flag: '🇷🇴', displayName: 'Romania', keywords: ['romania'] },
      { flag: '🇬🇷', displayName: 'Greece', keywords: ['greece'] },
      { flag: '🇵🇹', displayName: 'Portugal', keywords: ['portugal'] },
      { flag: '🇨🇭', displayName: 'Switzerland', keywords: ['switzerland'] },
      { flag: '🇦🇹', displayName: 'Austria', keywords: ['austria'] },
      { flag: '🇧🇪', displayName: 'Belgium', keywords: ['belgium'] },
      { flag: '🇧🇬', displayName: 'Bulgaria', keywords: ['bulgaria'] },
      { flag: '🇭🇷', displayName: 'Croatia', keywords: ['croatia'] },
      { flag: '🇸🇰', displayName: 'Slovakia', keywords: ['slovakia'] },
      { flag: '🇸🇮', displayName: 'Slovenia', keywords: ['slovenia'] },
      { flag: '🇷🇸', displayName: 'Serbia', keywords: ['serbia'] },
      { flag: '🇧🇦', displayName: 'Bosnia', keywords: ['bosnia'] },
      { flag: '🇦🇱', displayName: 'Albania', keywords: ['albania'] },
      { flag: '🇲🇰', displayName: 'North Macedonia', keywords: ['macedonia'] },
      { flag: '🇲🇪', displayName: 'Montenegro', keywords: ['montenegro'] },
      { flag: '🇱🇻', displayName: 'Latvia', keywords: ['latvia'] },
      { flag: '🇱🇹', displayName: 'Lithuania', keywords: ['lithuania'] },
      { flag: '🇪🇪', displayName: 'Estonia', keywords: ['estonia'] },
      { flag: '🇧🇾', displayName: 'Belarus', keywords: ['belarus'] },
      { flag: '🇲🇩', displayName: 'Moldova', keywords: ['moldova'] },
      { flag: '🇮🇪', displayName: 'Ireland', keywords: ['ireland'] },
      { flag: '🇸🇪', displayName: 'Sweden', keywords: ['sweden'] },
      { flag: '🇮🇸', displayName: 'Iceland', keywords: ['iceland'] },
      { flag: '🇱🇺', displayName: 'Luxembourg', keywords: ['luxembourg'] },
      { flag: '🇲🇹', displayName: 'Malta', keywords: ['malta'] },
      { flag: '🇨🇾', displayName: 'Cyprus', keywords: ['cyprus'] },
      // Africa
      { flag: '🇪🇬', displayName: 'Egypt', keywords: ['egypt', 'egypte'] },
      { flag: '🇳🇬', displayName: 'Nigeria', keywords: ['nigeria'] },
      { flag: '🇿🇦', displayName: 'South Africa', keywords: ['south africa'] },
      { flag: '🇹🇳', displayName: 'Tunisia', keywords: ['tunisia', 'tunisie'] },
      { flag: '🇲🇦', displayName: 'Morocco', keywords: ['morocco', 'maroc'] },
      { flag: '🇩🇿', displayName: 'Algeria', keywords: ['algeria', 'algerie'] },
      { flag: '🇪🇹', displayName: 'Ethiopia', keywords: ['ethiopia'] },
      { flag: '🇬🇭', displayName: 'Ghana', keywords: ['ghana'] },
      { flag: '🇰🇪', displayName: 'Kenya', keywords: ['kenya'] },
      { flag: '🇹🇿', displayName: 'Tanzania', keywords: ['tanzania'] },
      { flag: '🇺🇬', displayName: 'Uganda', keywords: ['uganda'] },
      { flag: '🇲🇿', displayName: 'Mozambique', keywords: ['mozambique'] },
      { flag: '🇿🇲', displayName: 'Zambia', keywords: ['zambia'] },
      { flag: '🇿🇼', displayName: 'Zimbabwe', keywords: ['zimbabwe'] },
      { flag: '🇨🇲', displayName: 'Cameroon', keywords: ['cameroon', 'cameroun'] },
      { flag: '🇸🇳', displayName: 'Senegal', keywords: ['senegal'] },
      { flag: '🇨🇮', displayName: "Côte d'Ivoire", keywords: ['ivory coast', "cote d'ivoire", 'cote divoire'] },
      { flag: '🇲🇱', displayName: 'Mali', keywords: ['mali'] },
      { flag: '🇧🇫', displayName: 'Burkina Faso', keywords: ['burkina'] },
      { flag: '🇳🇪', displayName: 'Niger', keywords: ['niger'] },
      { flag: '🇬🇳', displayName: 'Guinea', keywords: ['guinea'] },
      { flag: '🇷🇼', displayName: 'Rwanda', keywords: ['rwanda'] },
      { flag: '🇸🇩', displayName: 'Sudan', keywords: ['sudan'] },
      { flag: '🇸🇸', displayName: 'South Sudan', keywords: ['south sudan'] },
      { flag: '🇸🇴', displayName: 'Somalia', keywords: ['somalia'] },
      { flag: '🇱🇾', displayName: 'Libya', keywords: ['libya'] },
      { flag: '🇨🇩', displayName: 'Congo', keywords: ['congo', 'drc'] },
      { flag: '🇦🇴', displayName: 'Angola', keywords: ['angola'] },
      { flag: '🇲🇬', displayName: 'Madagascar', keywords: ['madagascar'] },
      { flag: '🇧🇯', displayName: 'Benin', keywords: ['benin'] },
      { flag: '🇹🇬', displayName: 'Togo', keywords: ['togo'] },
      { flag: '🇲🇼', displayName: 'Malawi', keywords: ['malawi'] },
      { flag: '🇳🇦', displayName: 'Namibia', keywords: ['namibia'] },
      { flag: '🇧🇼', displayName: 'Botswana', keywords: ['botswana'] },
      { flag: '🇱🇷', displayName: 'Liberia', keywords: ['liberia'] },
      { flag: '🇸🇱', displayName: 'Sierra Leone', keywords: ['sierra leone'] },
      // Americas
      { flag: '🇺🇸', displayName: 'USA', keywords: ['usa', 'united states', 'america'] },
      { flag: '🇨🇦', displayName: 'Canada', keywords: ['canada'] },
      { flag: '🇧🇷', displayName: 'Brazil', keywords: ['brazil', 'brasil'] },
      { flag: '🇲🇽', displayName: 'Mexico', keywords: ['mexico'] },
      { flag: '🇦🇷', displayName: 'Argentina', keywords: ['argentina'] },
      { flag: '🇨🇴', displayName: 'Colombia', keywords: ['colombia'] },
      { flag: '🇵🇪', displayName: 'Peru', keywords: ['peru'] },
      { flag: '🇨🇱', displayName: 'Chile', keywords: ['chile'] },
      { flag: '🇻🇪', displayName: 'Venezuela', keywords: ['venezuela'] },
      { flag: '🇪🇨', displayName: 'Ecuador', keywords: ['ecuador'] },
      { flag: '🇧🇴', displayName: 'Bolivia', keywords: ['bolivia'] },
      { flag: '🇵🇾', displayName: 'Paraguay', keywords: ['paraguay'] },
      { flag: '🇺🇾', displayName: 'Uruguay', keywords: ['uruguay'] },
      { flag: '🇬🇹', displayName: 'Guatemala', keywords: ['guatemala'] },
      { flag: '🇨🇺', displayName: 'Cuba', keywords: ['cuba'] },
      { flag: '🇩🇴', displayName: 'Dominican Republic', keywords: ['dominican'] },
      { flag: '🇭🇹', displayName: 'Haiti', keywords: ['haiti'] },
      { flag: '🇵🇦', displayName: 'Panama', keywords: ['panama'] },
      // Western Europe
      { flag: '🇬🇧', displayName: 'UK', keywords: ['uk', 'united kingdom', 'britain', 'england'] },
      { flag: '🇩🇪', displayName: 'Germany', keywords: ['germany', 'deutschland', 'allemagne'] },
      { flag: '🇫🇷', displayName: 'France', keywords: ['france', 'french'] },
      { flag: '🇮🇹', displayName: 'Italy', keywords: ['italy', 'italia'] },
      { flag: '🇪🇸', displayName: 'Spain', keywords: ['spain', 'espana', 'espagne'] },
      // Oceania
      { flag: '🇦🇺', displayName: 'Australia', keywords: ['australia'] },
      { flag: '🇳🇿', displayName: 'New Zealand', keywords: ['new zealand'] },
    ];

    // Longest keyword first for specific matches
    countryKeywords.sort((a, b) => {
      const maxA = Math.max(...a.keywords.map(k => k.length));
      const maxB = Math.max(...b.keywords.map(k => k.length));
      return maxB - maxA;
    });

    for (const country of countryKeywords) {
      for (const kw of country.keywords) {
        if (name.includes(kw)) {
          return {
            flag: country.flag,
            displayName: country.displayName,
            key: country.displayName.toLowerCase().replace(/\s+/g, '_')
          };
        }
      }
    }

    // Fallback: phone number prefix থেকে country detect
    const phoneMatch = rangeName.match(/\b(\d{6,})\b/);
    if (phoneMatch) {
      const info = this._getCountryInfo(phoneMatch[1]);
      if (info && info.name !== 'Unknown') {
        return { flag: info.flag, displayName: info.name, key: info.name.toLowerCase().replace(/\s+/g, '_') };
      }
    }

    return { flag: '🌐', displayName: 'Other', key: 'other' };
  }

  _getCountryInfo(phoneNumber) {
    const num = (phoneNumber || '').replace(/[\s\-\+\(\)]/g, '');

    const countries = [
      { prefix: '1', flag: '🇺🇸', name: 'USA/Canada' },
      { prefix: '1242', flag: '🇧🇸', name: 'Bahamas' },
      { prefix: '1246', flag: '🇧🇧', name: 'Barbados' },
      { prefix: '1264', flag: '🇦🇮', name: 'Anguilla' },
      { prefix: '1268', flag: '🇦🇬', name: 'Antigua and Barbuda' },
      { prefix: '1284', flag: '🇻🇬', name: 'British Virgin Islands' },
      { prefix: '1340', flag: '🇻🇮', name: 'US Virgin Islands' },
      { prefix: '1345', flag: '🇰🇾', name: 'Cayman Islands' },
      { prefix: '1441', flag: '🇧🇲', name: 'Bermuda' },
      { prefix: '1473', flag: '🇬🇩', name: 'Grenada' },
      { prefix: '1649', flag: '🇹🇨', name: 'Turks and Caicos Islands' },
      { prefix: '1664', flag: '🇲🇸', name: 'Montserrat' },
      { prefix: '1670', flag: '🇲🇵', name: 'Northern Mariana Islands' },
      { prefix: '1671', flag: '🇬🇺', name: 'Guam' },
      { prefix: '1684', flag: '🇦🇸', name: 'American Samoa' },
      { prefix: '1721', flag: '🇸🇽', name: 'Sint Maarten' },
      { prefix: '1758', flag: '🇱🇨', name: 'Saint Lucia' },
      { prefix: '1767', flag: '🇩🇲', name: 'Dominica' },
      { prefix: '1784', flag: '🇻🇨', name: 'Saint Vincent and the Grenadines' },
      { prefix: '1868', flag: '🇹🇹', name: 'Trinidad and Tobago' },
      { prefix: '1869', flag: '🇰🇳', name: 'Saint Kitts and Nevis' },
      { prefix: '1876', flag: '🇯🇲', name: 'Jamaica' },
      { prefix: '20', flag: '🇪🇬', name: 'Egypt' },
      { prefix: '211', flag: '🇸🇸', name: 'South Sudan' },
      { prefix: '212', flag: '🇲🇦', name: 'Morocco' },
      { prefix: '213', flag: '🇩🇿', name: 'Algeria' },
      { prefix: '216', flag: '🇹🇳', name: 'Tunisia' },
      { prefix: '218', flag: '🇱🇾', name: 'Libya' },
      { prefix: '220', flag: '🇬🇲', name: 'Gambia' },
      { prefix: '221', flag: '🇸🇳', name: 'Senegal' },
      { prefix: '222', flag: '🇲🇷', name: 'Mauritania' },
      { prefix: '223', flag: '🇲🇱', name: 'Mali' },
      { prefix: '224', flag: '🇬🇳', name: 'Guinea' },
      { prefix: '225', flag: '🇨🇮', name: 'Ivory Coast' },
      { prefix: '226', flag: '🇧🇫', name: 'Burkina Faso' },
      { prefix: '227', flag: '🇳🇪', name: 'Niger' },
      { prefix: '228', flag: '🇹🇬', name: 'Togo' },
      { prefix: '229', flag: '🇧🇯', name: 'Benin' },
      { prefix: '230', flag: '🇲🇺', name: 'Mauritius' },
      { prefix: '231', flag: '🇱🇷', name: 'Liberia' },
      { prefix: '232', flag: '🇸🇱', name: 'Sierra Leone' },
      { prefix: '233', flag: '🇬🇭', name: 'Ghana' },
      { prefix: '234', flag: '🇳🇬', name: 'Nigeria' },
      { prefix: '235', flag: '🇹🇩', name: 'Chad' },
      { prefix: '236', flag: '🇨🇫', name: 'Central African Republic' },
      { prefix: '237', flag: '🇨🇲', name: 'Cameroon' },
      { prefix: '238', flag: '🇨🇻', name: 'Cape Verde' },
      { prefix: '239', flag: '🇸🇹', name: 'Sao Tome and Principe' },
      { prefix: '240', flag: '🇬🇶', name: 'Equatorial Guinea' },
      { prefix: '241', flag: '🇬🇦', name: 'Gabon' },
      { prefix: '242', flag: '🇨🇬', name: 'Republic of the Congo' },
      { prefix: '243', flag: '🇨🇩', name: 'DR Congo' },
      { prefix: '244', flag: '🇦🇴', name: 'Angola' },
      { prefix: '245', flag: '🇬🇼', name: 'Guinea-Bissau' },
      { prefix: '246', flag: '🇮🇴', name: 'British Indian Ocean Territory' },
      { prefix: '247', flag: '🇦🇨', name: 'Ascension Island' },
      { prefix: '248', flag: '🇸🇨', name: 'Seychelles' },
      { prefix: '249', flag: '🇸🇩', name: 'Sudan' },
      { prefix: '250', flag: '🇷🇼', name: 'Rwanda' },
      { prefix: '251', flag: '🇪🇹', name: 'Ethiopia' },
      { prefix: '252', flag: '🇸🇴', name: 'Somalia' },
      { prefix: '253', flag: '🇩🇯', name: 'Djibouti' },
      { prefix: '254', flag: '🇰🇪', name: 'Kenya' },
      { prefix: '255', flag: '🇹🇿', name: 'Tanzania' },
      { prefix: '256', flag: '🇺🇬', name: 'Uganda' },
      { prefix: '257', flag: '🇧🇮', name: 'Burundi' },
      { prefix: '258', flag: '🇲🇿', name: 'Mozambique' },
      { prefix: '260', flag: '🇿🇲', name: 'Zambia' },
      { prefix: '261', flag: '🇲🇬', name: 'Madagascar' },
      { prefix: '262', flag: '🇷🇪', name: 'Reunion' },
      { prefix: '263', flag: '🇿🇼', name: 'Zimbabwe' },
      { prefix: '264', flag: '🇳🇦', name: 'Namibia' },
      { prefix: '265', flag: '🇲🇼', name: 'Malawi' },
      { prefix: '266', flag: '🇱🇸', name: 'Lesotho' },
      { prefix: '267', flag: '🇧🇼', name: 'Botswana' },
      { prefix: '268', flag: '🇸🇿', name: 'Eswatini' },
      { prefix: '269', flag: '🇰🇲', name: 'Comoros' },
      { prefix: '27', flag: '🇿🇦', name: 'South Africa' },
      { prefix: '290', flag: '🇸🇭', name: 'Saint Helena' },
      { prefix: '291', flag: '🇪🇷', name: 'Eritrea' },
      { prefix: '297', flag: '🇦🇼', name: 'Aruba' },
      { prefix: '298', flag: '🇫🇴', name: 'Faroe Islands' },
      { prefix: '299', flag: '🇬🇱', name: 'Greenland' },
      { prefix: '30', flag: '🇬🇷', name: 'Greece' },
      { prefix: '31', flag: '🇳🇱', name: 'Netherlands' },
      { prefix: '32', flag: '🇧🇪', name: 'Belgium' },
      { prefix: '33', flag: '🇫🇷', name: 'France' },
      { prefix: '34', flag: '🇪🇸', name: 'Spain' },
      { prefix: '350', flag: '🇬🇮', name: 'Gibraltar' },
      { prefix: '351', flag: '🇵🇹', name: 'Portugal' },
      { prefix: '352', flag: '🇱🇺', name: 'Luxembourg' },
      { prefix: '353', flag: '🇮🇪', name: 'Ireland' },
      { prefix: '354', flag: '🇮🇸', name: 'Iceland' },
      { prefix: '355', flag: '🇦🇱', name: 'Albania' },
      { prefix: '356', flag: '🇲🇹', name: 'Malta' },
      { prefix: '357', flag: '🇨🇾', name: 'Cyprus' },
      { prefix: '358', flag: '🇫🇮', name: 'Finland' },
      { prefix: '359', flag: '🇧🇬', name: 'Bulgaria' },
      { prefix: '36', flag: '🇭🇺', name: 'Hungary' },
      { prefix: '370', flag: '🇱🇹', name: 'Lithuania' },
      { prefix: '371', flag: '🇱🇻', name: 'Latvia' },
      { prefix: '372', flag: '🇪🇪', name: 'Estonia' },
      { prefix: '373', flag: '🇲🇩', name: 'Moldova' },
      { prefix: '374', flag: '🇦🇲', name: 'Armenia' },
      { prefix: '375', flag: '🇧🇾', name: 'Belarus' },
      { prefix: '376', flag: '🇦🇩', name: 'Andorra' },
      { prefix: '377', flag: '🇲🇨', name: 'Monaco' },
      { prefix: '378', flag: '🇸🇲', name: 'San Marino' },
      { prefix: '380', flag: '🇺🇦', name: 'Ukraine' },
      { prefix: '381', flag: '🇷🇸', name: 'Serbia' },
      { prefix: '382', flag: '🇲🇪', name: 'Montenegro' },
      { prefix: '383', flag: '🇽🇰', name: 'Kosovo' },
      { prefix: '385', flag: '🇭🇷', name: 'Croatia' },
      { prefix: '386', flag: '🇸🇮', name: 'Slovenia' },
      { prefix: '387', flag: '🇧🇦', name: 'Bosnia and Herzegovina' },
      { prefix: '389', flag: '🇲🇰', name: 'North Macedonia' },
      { prefix: '39', flag: '🇮🇹', name: 'Italy' },
      { prefix: '40', flag: '🇷🇴', name: 'Romania' },
      { prefix: '41', flag: '🇨🇭', name: 'Switzerland' },
      { prefix: '420', flag: '🇨🇿', name: 'Czechia' },
      { prefix: '421', flag: '🇸🇰', name: 'Slovakia' },
      { prefix: '423', flag: '🇱🇮', name: 'Liechtenstein' },
      { prefix: '43', flag: '🇦🇹', name: 'Austria' },
      { prefix: '44', flag: '🇬🇧', name: 'UK' },
      { prefix: '45', flag: '🇩🇰', name: 'Denmark' },
      { prefix: '46', flag: '🇸🇪', name: 'Sweden' },
      { prefix: '47', flag: '🇳🇴', name: 'Norway' },
      { prefix: '48', flag: '🇵🇱', name: 'Poland' },
      { prefix: '49', flag: '🇩🇪', name: 'Germany' },
      { prefix: '500', flag: '🇫🇰', name: 'Falkland Islands' },
      { prefix: '501', flag: '🇧🇿', name: 'Belize' },
      { prefix: '502', flag: '🇬🇹', name: 'Guatemala' },
      { prefix: '503', flag: '🇸🇻', name: 'El Salvador' },
      { prefix: '504', flag: '🇭🇳', name: 'Honduras' },
      { prefix: '505', flag: '🇳🇮', name: 'Nicaragua' },
      { prefix: '506', flag: '🇨🇷', name: 'Costa Rica' },
      { prefix: '507', flag: '🇵🇦', name: 'Panama' },
      { prefix: '508', flag: '🇵🇲', name: 'Saint Pierre and Miquelon' },
      { prefix: '509', flag: '🇭🇹', name: 'Haiti' },
      { prefix: '51', flag: '🇵🇪', name: 'Peru' },
      { prefix: '52', flag: '🇲🇽', name: 'Mexico' },
      { prefix: '53', flag: '🇨🇺', name: 'Cuba' },
      { prefix: '54', flag: '🇦🇷', name: 'Argentina' },
      { prefix: '55', flag: '🇧🇷', name: 'Brazil' },
      { prefix: '56', flag: '🇨🇱', name: 'Chile' },
      { prefix: '57', flag: '🇨🇴', name: 'Colombia' },
      { prefix: '58', flag: '🇻🇪', name: 'Venezuela' },
      { prefix: '590', flag: '🇬🇵', name: 'Guadeloupe' },
      { prefix: '591', flag: '🇧🇴', name: 'Bolivia' },
      { prefix: '592', flag: '🇬🇾', name: 'Guyana' },
      { prefix: '593', flag: '🇪🇨', name: 'Ecuador' },
      { prefix: '594', flag: '🇬🇫', name: 'French Guiana' },
      { prefix: '595', flag: '🇵🇾', name: 'Paraguay' },
      { prefix: '596', flag: '🇲🇶', name: 'Martinique' },
      { prefix: '597', flag: '🇸🇷', name: 'Suriname' },
      { prefix: '598', flag: '🇺🇾', name: 'Uruguay' },
      { prefix: '599', flag: '🇨🇼', name: 'Curacao' },
      { prefix: '60', flag: '🇲🇾', name: 'Malaysia' },
      { prefix: '61', flag: '🇦🇺', name: 'Australia' },
      { prefix: '62', flag: '🇮🇩', name: 'Indonesia' },
      { prefix: '63', flag: '🇵🇭', name: 'Philippines' },
      { prefix: '64', flag: '🇳🇿', name: 'New Zealand' },
      { prefix: '65', flag: '🇸🇬', name: 'Singapore' },
      { prefix: '66', flag: '🇹🇭', name: 'Thailand' },
      { prefix: '670', flag: '🇹🇱', name: 'East Timor' },
      { prefix: '672', flag: '🇳🇫', name: 'Norfolk Island' },
      { prefix: '673', flag: '🇧🇳', name: 'Brunei' },
      { prefix: '674', flag: '🇳🇷', name: 'Nauru' },
      { prefix: '675', flag: '🇵🇬', name: 'Papua New Guinea' },
      { prefix: '676', flag: '🇹🇴', name: 'Tonga' },
      { prefix: '677', flag: '🇸🇧', name: 'Solomon Islands' },
      { prefix: '678', flag: '🇻🇺', name: 'Vanuatu' },
      { prefix: '679', flag: '🇫🇯', name: 'Fiji' },
      { prefix: '680', flag: '🇵🇼', name: 'Palau' },
      { prefix: '681', flag: '🇼🇫', name: 'Wallis and Futuna' },
      { prefix: '682', flag: '🇨🇰', name: 'Cook Islands' },
      { prefix: '683', flag: '🇳🇺', name: 'Niue' },
      { prefix: '685', flag: '🇼🇸', name: 'Samoa' },
      { prefix: '686', flag: '🇰🇮', name: 'Kiribati' },
      { prefix: '687', flag: '🇳🇨', name: 'New Caledonia' },
      { prefix: '688', flag: '🇹🇻', name: 'Tuvalu' },
      { prefix: '689', flag: '🇵🇫', name: 'French Polynesia' },
      { prefix: '690', flag: '🇹🇰', name: 'Tokelau' },
      { prefix: '691', flag: '🇫🇲', name: 'Micronesia' },
      { prefix: '692', flag: '🇲🇭', name: 'Marshall Islands' },
      { prefix: '7', flag: '🇷🇺', name: 'Russia/Kazakhstan' },
      { prefix: '81', flag: '🇯🇵', name: 'Japan' },
      { prefix: '82', flag: '🇰🇷', name: 'South Korea' },
      { prefix: '84', flag: '🇻🇳', name: 'Vietnam' },
      { prefix: '850', flag: '🇰🇵', name: 'North Korea' },
      { prefix: '852', flag: '🇭🇰', name: 'Hong Kong' },
      { prefix: '853', flag: '🇲🇴', name: 'Macau' },
      { prefix: '855', flag: '🇰🇭', name: 'Cambodia' },
      { prefix: '856', flag: '🇱🇦', name: 'Laos' },
      { prefix: '86', flag: '🇨🇳', name: 'China' },
      { prefix: '880', flag: '🇧🇩', name: 'Bangladesh' },
      { prefix: '886', flag: '🇹🇼', name: 'Taiwan' },
      { prefix: '90', flag: '🇹🇷', name: 'Turkey' },
      { prefix: '91', flag: '🇮🇳', name: 'India' },
      { prefix: '92', flag: '🇵🇰', name: 'Pakistan' },
      { prefix: '93', flag: '🇦🇫', name: 'Afghanistan' },
      { prefix: '94', flag: '🇱🇰', name: 'Sri Lanka' },
      { prefix: '95', flag: '🇲🇲', name: 'Myanmar' },
      { prefix: '960', flag: '🇲🇻', name: 'Maldives' },
      { prefix: '961', flag: '🇱🇧', name: 'Lebanon' },
      { prefix: '962', flag: '🇯🇴', name: 'Jordan' },
      { prefix: '963', flag: '🇸🇾', name: 'Syria' },
      { prefix: '964', flag: '🇮🇶', name: 'Iraq' },
      { prefix: '965', flag: '🇰🇼', name: 'Kuwait' },
      { prefix: '966', flag: '🇸🇦', name: 'Saudi Arabia' },
      { prefix: '967', flag: '🇾🇪', name: 'Yemen' },
      { prefix: '968', flag: '🇴🇲', name: 'Oman' },
      { prefix: '970', flag: '🇵🇸', name: 'Palestine' },
      { prefix: '971', flag: '🇦🇪', name: 'UAE' },
      { prefix: '972', flag: '🇮🇱', name: 'Israel' },
      { prefix: '973', flag: '🇧🇭', name: 'Bahrain' },
      { prefix: '974', flag: '🇶🇦', name: 'Qatar' },
      { prefix: '975', flag: '🇧🇹', name: 'Bhutan' },
      { prefix: '976', flag: '🇲🇳', name: 'Mongolia' },
      { prefix: '977', flag: '🇳🇵', name: 'Nepal' },
      { prefix: '98', flag: '🇮🇷', name: 'Iran' },
      { prefix: '992', flag: '🇹🇯', name: 'Tajikistan' },
      { prefix: '993', flag: '🇹🇲', name: 'Turkmenistan' },
      { prefix: '994', flag: '🇦🇿', name: 'Azerbaijan' },
      { prefix: '995', flag: '🇬🇪', name: 'Georgia' },
      { prefix: '996', flag: '🇰🇬', name: 'Kyrgyzstan' },
      { prefix: '998', flag: '🇺🇿', name: 'Uzbekistan' }
    ];

    countries.sort((a, b) => b.prefix.length - a.prefix.length);

    for (const c of countries) {
      if (num.startsWith(c.prefix)) {
        return c;
      }
    }

    return { flag: '🌐', name: 'Unknown' };
  }

  /**
   * অ্যাপ মেনু কীবোর্ড — admin হলে অতিরিক্ত বাটন দেখাবে
   */
  _getAppMenuKeyboard(userId) {
    const apps = config.SUPPORTED_APPS;
    const rows = [];
    for (let i = 0; i < apps.length; i += 2) {
      const row = [];
      row.push({
        text: `${apps[i].emoji}${apps[i].emoji ? ' ' : ''}${apps[i].name}`,
        callback_data: `app_${apps[i].id}`
      });
      if (i + 1 < apps.length) {
        row.push({
          text: `${apps[i + 1].emoji}${apps[i + 1].emoji ? ' ' : ''}${apps[i + 1].name}`,
          callback_data: `app_${apps[i + 1].id}`
        });
      }
      rows.push(row);
    }

    // Admin-only বাটন
    if (userId && this._isAdmin(userId)) {
      rows.push([
        { text: '📊 Status', callback_data: 'refresh_status' },
        { text: '📈 OTP Stats', callback_data: 'admin_view_stats' }
      ]);
      rows.push(
        [
          { text: '➕ Range Add', callback_data: 'admin_range_add' },
          { text: '📋 Mapping', callback_data: 'admin_view_mapping' }
        ]
      );
      rows.push([{ text: '🎛️ Panel Settings', callback_data: 'admin_panel_settings' }, { text: '👑 Add Admin', callback_data: 'admin_add_admin_menu' }]);
      const toggleText = global.botDisabled ? '🟢 Enable Bot' : '🔴 Disable Bot';
      rows.push([{ text: toggleText, callback_data: 'admin_toggle_bot' }]);
    } else {
      rows.push([{ text: '📖 Help', callback_data: 'help' }]);
    }

    return rows;
  }

  _isAuthorized(userId) {
    if (this._isAdmin(userId)) return true;
    if (!config.ALLOWED_USERS || config.ALLOWED_USERS.length === 0) return true;
    if (config.ALLOWED_USERS.includes(userId)) return true;
    if (config.ALLOWED_USERS.includes(parseInt(userId, 10))) return true;
    return false;
  }

  _isAdmin(userId) {
    if (config.ADMIN_USER_IDS && config.ADMIN_USER_IDS.includes(userId)) return true;
    try {
      const adminInDb = db.prepare('SELECT 1 FROM bot_admins WHERE user_id = ?').get(userId);
      if (adminInDb) return true;
    } catch(e) {}
    return false;
  }

  async _handleMyId(msg) {
    const userId = msg.from.id;
    const userName = msg.from.username || msg.from.first_name || 'Unknown';
    await this._safeSend(userId,
      `🪪 *Your Info:*\n\n` +
      `👤 Name: ${userName}\n` +
      `🔢 User ID: \`${userId}\`\n` +
      `📝 Username: @${msg.from.username || 'N/A'}\n\n` +
      `💡 Use this ID in ADMIN_USER_ID or ALLOWED_USERS.`,
      { parse_mode: 'Markdown' }
    );
  }

  async _handleAddAdmin(msg, match) {
    const adminId = msg.from.id;
    if (!this._isAdmin(adminId)) {
      await this._safeSend(adminId, '⛔ Only admin can use this command.');
      return;
    }
    const newAdminId = parseInt(match[1].trim(), 10);
    if (isNaN(newAdminId)) {
      await this._safeSend(adminId, '❌ Please provide a valid User ID. Example: /addadmin 123456789');
      return;
    }
    if (this._isAdmin(newAdminId)) {
      await this._safeSend(adminId, `⚠️ User ${newAdminId} is already an admin.`);
      return;
    }
    
    try {
      db.prepare('INSERT OR IGNORE INTO bot_admins (user_id) VALUES (?)').run(newAdminId);
      await this._safeSend(adminId,
        `👑 *New Admin Added!*\n\n` +
        `👤 User ID: \`${newAdminId}\`\n\n` +
        `They now have full admin access.`,
        { parse_mode: 'Markdown' }
      );
    } catch(e) {
      await this._safeSend(adminId, `❌ Failed to add admin: ${e.message}`);
    }
  }

  async _handleRemoveAdmin(msg, match) {
    const adminId = msg.from.id;
    if (!this._isAdmin(adminId)) {
      await this._safeSend(adminId, '⛔ Only admin can use this command.');
      return;
    }
    const removeAdminId = parseInt(match[1].trim(), 10);
    if (isNaN(removeAdminId)) {
      await this._safeSend(adminId, '❌ Please provide a valid User ID. Example: /removeadmin 123456789');
      return;
    }
    
    // Check if trying to remove from config (hardcoded)
    if (config.ADMIN_USER_IDS && config.ADMIN_USER_IDS.includes(removeAdminId)) {
      await this._safeSend(adminId, `⚠️ User ${removeAdminId} is a master admin in config.js and cannot be removed here.`);
      return;
    }
    
    try {
      const result = db.prepare('DELETE FROM bot_admins WHERE user_id = ?').run(removeAdminId);
      if (result.changes > 0) {
        await this._safeSend(adminId, `✅ Admin access removed for User ID: \`${removeAdminId}\``, { parse_mode: 'Markdown' });
      } else {
        await this._safeSend(adminId, `⚠️ User ${removeAdminId} is not an admin.`);
      }
    } catch(e) {
      await this._safeSend(adminId, `❌ Failed to remove admin: ${e.message}`);
    }
  }

  async _handleAdminsList(msg) {
    const adminId = msg.from.id;
    if (!this._isAdmin(adminId)) {
      await this._safeSend(adminId, '⛔ Only admin can use this command.');
      return;
    }
    
    let text = `👑 *Admin List*\n\n`;
    
    // Master admins
    if (config.ADMIN_USER_IDS && config.ADMIN_USER_IDS.length > 0) {
      text += `*Master Admins (Config)*\n`;
      for (const id of config.ADMIN_USER_IDS) {
        text += `• \`${id}\`\n`;
      }
      text += `\n`;
    }
    
    // Dynamic admins
    try {
      const dbAdmins = db.prepare('SELECT user_id, added_at FROM bot_admins ORDER BY added_at DESC').all();
      text += `*Dynamic Admins (Database)*\n`;
      if (dbAdmins.length === 0) {
        text += `_No dynamic admins added yet._\n`;
      } else {
        for (const row of dbAdmins) {
          text += `• \`${row.user_id}\` _(Added: ${row.added_at})_\n`;
        }
      }
    } catch(e) {}
    
    await this._safeSend(adminId, text, { parse_mode: 'Markdown' });
  }

  async _handleAddUser(msg, match) {
    const adminId = msg.from.id;
    if (!this._isAdmin(adminId)) {
      await this._safeSend(adminId, '⛔ Only admin can use this command.');
      return;
    }
    const newUserId = parseInt(match[1].trim(), 10);
    if (isNaN(newUserId)) {
      await this._safeSend(adminId, '❌ Please provide a valid ID. Example: /adduser 123456789');
      return;
    }
    if (config.ALLOWED_USERS.includes(newUserId)) {
      await this._safeSend(adminId, `⚠️ User ${newUserId} is already authorized.`);
      return;
    }
    config.ALLOWED_USERS.push(newUserId);
    await this._safeSend(adminId,
      `✅ New user added!\n\n` +
      `🔢 User ID: \`${newUserId}\`\n` +
      `📋 Total: ${config.ALLOWED_USERS.length} users`,
      { parse_mode: 'Markdown' }
    );
  }

  async _handleRemoveUser(msg, match) {
    const adminId = msg.from.id;
    if (!this._isAdmin(adminId)) {
      await this._safeSend(adminId, '⛔ Only admin can use this command.');
      return;
    }
    const removeId = parseInt(match[1].trim(), 10);
    const index = config.ALLOWED_USERS.indexOf(removeId);
    if (index === -1) {
      await this._safeSend(adminId, `⚠️ User ${removeId} is not in the list.`);
      return;
    }
    config.ALLOWED_USERS.splice(index, 1);
    await this._safeSend(adminId,
      `✅ User \`${removeId}\` has been removed.`,
      { parse_mode: 'Markdown' }
    );
  }

  async _handleUsers(msg) {
    const adminId = msg.from.id;
    if (!this._isAdmin(adminId)) {
      await this._safeSend(adminId, '⛔ Only admin can use this command.');
      return;
    }
    let text = `👤 *Authorized Users:*\n\n`;
    text += `👑 Admin: \`${config.ADMIN_USER_ID}\`\n\n`;
    if (config.ALLOWED_USERS.length === 0) {
      text += '🌐 Everyone is allowed';
    } else {
      config.ALLOWED_USERS.forEach((id, i) => {
        text += `${i + 1}. \`${id}\`\n`;
      });
    }
    await this._safeSend(adminId, text, { parse_mode: 'Markdown' });
  }

  async _handleRanges(msg) {
    const userId = msg.from.id;
    if (!this._isAdmin(userId)) {
      await this._safeSend(userId, '⛔ Only admin can use this command.');
      return;
    }

    const loadingMsg = await this._safeSend(userId,
      '🔄 Fetching ranges from all panels...\n\n⏳ Please wait...',
      { parse_mode: 'Markdown' }
    );
    if (!loadingMsg) return;

    try {
      const allRanges = await panelManager.getAllRanges();

      let text = '📋 *Available Range List*\n\n';
      text += '(From the Range column on the My Numbers page)\n\n';

      let hasData = false;

      for (const [panelName, ranges] of Object.entries(allRanges)) {
        if (!ranges || ranges.length === 0) {
          text += `🖥️ *${this._escapeMd(panelName)}*\n   ❌ No ranges found\n\n`;
          continue;
        }

        hasData = true;
        text += `🖥️ *${this._escapeMd(panelName)}* (${ranges.length} ranges)\n`;
        text += '```\n';

        const showRanges = ranges.slice(0, 30);
        for (const r of showRanges) {
          text += `  ${r.range} (${r.count})\n`;
        }

        if (ranges.length > 30) {
          text += `  ... and ${ranges.length - 30} more ranges\n`;
        }

        text += '```\n\n';
      }

      if (!hasData) {
        text += '❌ No ranges found from any panel.\n';
        text += 'Check panel login status (/status).\n';
      }

      text += '💡 *How to set up:*\n';
      text += '➕ Click the Range Add button\n';
      text += 'Or type:\n';
      text += '`Panel Name, Range Name, App ID`\n';
      text += 'Example: `Wolf SMS, Russia, whatsapp`';

      await this._safeEdit(userId, loadingMsg.message_id, text, {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [{ text: '🔄 View Again', callback_data: 'refresh_ranges' }],
            [{ text: '➕ Range Add', callback_data: 'admin_range_add' }],
            [{ text: '🏠 Main Menu', callback_data: 'main_menu' }]
          ]
        }
      });
    } catch (error) {
      console.error(`Error fetching ranges: ${error.message}`);
      await this._safeEdit(userId, loadingMsg.message_id,
        '❌ Problem fetching ranges. Please try again.',
        { parse_mode: 'Markdown' }
      );
    }
  }



  // ==========================================
  // Admin Panel Settings
  // ==========================================

  async _showPanelSettings(userId, messageId) {
    const statuses = panelManager.getStatus();

    let text = '🎛️ *Panel Settings*\n\nClick on a panel below to turn it ON or OFF:\n\n';

    const kb = [];
    for (const p of statuses) {
      const icon = p.isEnabled ? '🟢' : '🔴';
      const isDyn = p.isDynamic ? ' ' : '';
      const label = `${icon} ${p.name}${isDyn}`;

      const row = [{ text: label, callback_data: `toggle_panel:${p.name}` }];
      if (p.isDynamic) {
        row.push({ text: '🗑️ Delete', callback_data: `delete_panel:${p.name}` });
      }
      kb.push(row);
    }

    kb.push([{ text: '➕ Add New Panel', callback_data: 'add_panel_start' }]);
    kb.push([{ text: '« Back', callback_data: 'main_menu' }]);

    await this._safeEdit(userId, messageId, text, {
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: kb }
    });
  }

  // ==========================================
  // Dynamic Panel Adding Flow
  // ==========================================

  async _handleAddPanelInput(userId, text, messageId) {
    const state = this._addPanelState.get(userId);
    if (!state) return;

    // Delete user's message to keep the chat clean
    try {
      await this._apiCall('deleteMessage', { chat_id: userId, message_id: messageId });
    } catch (e) { }

    if (state.step === 'name') {
      const exists = panelManager.getStatus().some(p => p.name.toLowerCase() === text.toLowerCase());
      if (exists) {
        await this._safeSend(userId, '⚠️ A panel with this name already exists. Please choose a different name:');
        return;
      }
      state.name = text;
      state.step = 'url';
      const stepNum = 3;
      await this._safeSend(userId,
        `🖥️ Panel Name: *${this._escapeMd(state.name)}*\n\n` +
        `Step ${stepNum}: Please enter the **Base URL** of the panel (e.g., \`http://168.119.13.175\` or \`http://smshadi.net\`):`,
        {
          parse_mode: 'Markdown',
          reply_markup: { inline_keyboard: [[{ text: '❌ Cancel', callback_data: 'add_panel_cancel' }]] }
        }
      );
      return;
    }

    if (state.step === 'url') {
      let url = text;
      if (!url.startsWith('http://') && !url.startsWith('https://')) {
        url = 'http://' + url;
      }
      url = url.replace(/\/+$/, '');

      state.baseUrl = url;
      state.step = 'username';
      const credLabel = state.type === 'ins' ? 'Email Address' : 'Username';
      await this._safeSend(userId,
        `🖥️ Panel Name: *${this._escapeMd(state.name)}*\n` +
        `🌐 Base URL: \`${state.baseUrl}\`\n\n` +
        `Step 4: Please enter the **${credLabel}** for the panel:`,
        {
          parse_mode: 'Markdown',
          reply_markup: { inline_keyboard: [[{ text: '❌ Cancel', callback_data: 'add_panel_cancel' }]] }
        }
      );
      return;
    }

    if (state.step === 'username') {
      state.username = text;
      state.step = 'password';
      const credLabel = state.type === 'ins' ? 'Email' : 'Username';
      await this._safeSend(userId,
        `🖥️ Panel Name: *${this._escapeMd(state.name)}*\n` +
        `🌐 Base URL: \`${state.baseUrl}\`\n` +
        `📧 ${credLabel}: \`${this._escapeMd(state.username)}\`\n\n` +
        `Step 5: Please enter the **Password** for the panel:`,
        {
          parse_mode: 'Markdown',
          reply_markup: { inline_keyboard: [[{ text: '❌ Cancel', callback_data: 'add_panel_cancel' }]] }
        }
      );
      return;
    }

    if (state.step === 'password') {
      state.password = text;

      // INS API type: skip path configuration, use fixed API defaults
      if (state.type === 'ins') {
        state.step = 'paths';
        state.loginPageUrl = '/api/auth/login';
        state.signinUrl = '/api/auth/login';
        state.dashboardPath = '';
        await this._finalizePanelAdd(userId, null);
        return;
      }

      // Purple SMS type: skip path configuration, use fixed defaults
      if (state.type === 'purple') {
        state.step = 'paths';
        state.loginPageUrl = '/sms/SignIn';
        state.signinUrl = '/sms/signmein';
        state.dashboardPath = '/sms/reseller/MyNotifications';
        await this._finalizePanelAdd(userId, null);
        return;
      }

      // Wolf type: ask for paths
      state.step = 'paths';
      await this._safeSend(userId,
        `🖥️ Panel Name: *${this._escapeMd(state.name)}*\n` +
        `🌐 Base URL: \`${state.baseUrl}\`\n` +
        `👤 Username: \`${this._escapeMd(state.username)}\`\n` +
        `🔑 Password: \`********\`\n\n` +
        `Step 6: Do you want to use **Default Paths** or **Custom Paths**?\n\n` +
        `Default Paths:\n` +
        `• Login Page: \`/ints/login\`\n` +
        `• Signin POST URL: \`/ints/signin\`\n` +
        `• Dashboard Page: \`/ints/agent\``,
        {
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [
              [
                { text: '⚙️ Use Default Paths', callback_data: 'add_panel_use_default' },
                { text: '🔧 Use Custom Paths', callback_data: 'add_panel_use_custom' }
              ],
              [{ text: '❌ Cancel', callback_data: 'add_panel_cancel' }]
            ]
          }
        }
      );
      return;
    }

    if (state.step === 'login_path') {
      state.loginPageUrl = text.startsWith('/') ? text : '/' + text;
      state.step = 'signin_path';
      await this._safeSend(userId,
        `📝 Login Path: \`${state.loginPageUrl}\`\n\n` +
        `Enter the **Signin POST URL Path** (e.g., \`/ints/signin\` or \`/signin\`):`,
        {
          parse_mode: 'Markdown',
          reply_markup: { inline_keyboard: [[{ text: '❌ Cancel', callback_data: 'add_panel_cancel' }]] }
        }
      );
      return;
    }

    if (state.step === 'signin_path') {
      state.signinUrl = text.startsWith('/') ? text : '/' + text;
      state.step = 'dashboard_path';
      await this._safeSend(userId,
        `📝 Login Path: \`${state.loginPageUrl}\`\n` +
        `📝 Signin Path: \`${state.signinUrl}\`\n\n` +
        `Enter the **Dashboard Path** (e.g., \`/ints/agent\` or \`/agent\`):`,
        {
          parse_mode: 'Markdown',
          reply_markup: { inline_keyboard: [[{ text: '❌ Cancel', callback_data: 'add_panel_cancel' }]] }
        }
      );
      return;
    }

    if (state.step === 'dashboard_path') {
      state.dashboardPath = text.startsWith('/') ? text : '/' + text;
      await this._finalizePanelAdd(userId, null);
      return;
    }
  }

  async _finalizePanelAdd(userId, messageId) {
    const state = this._addPanelState.get(userId);
    if (!state) return;

    this._addPanelState.delete(userId);

    const loadingMsg = await this._safeSend(userId, '⏳ *Validating credentials and connecting to panel...*\nThis can take up to 15 seconds.', {
      parse_mode: 'Markdown'
    });

    try {
      const panelConfig = {
        name: state.name,
        type: state.type || 'wolf',
        baseUrl: state.baseUrl,
        loginPageUrl: state.loginPageUrl,
        signinUrl: state.signinUrl,
        dashboardPath: state.dashboardPath,
        username: state.username,
        password: state.password
      };

      await panelManager.addPanel(panelConfig);

      await this._safeSend(userId,
        `✅ *Panel Added Successfully!*\n\n` +
        `🖥️ Panel: *${this._escapeMd(state.name)}*\n` +
        `🌐 URL: \`${state.baseUrl}\`\n\n` +
        `Login verification passed. The panel is now live and will start fetching numbers immediately.`,
        {
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [
              [{ text: '🎛️ Panel Settings', callback_data: 'admin_panel_settings' }],
              [{ text: '🏠 Main Menu', callback_data: 'main_menu' }]
            ]
          }
        }
      );
    } catch (err) {
      await this._safeSend(userId,
        `❌ *Login Verification Failed!*\n\n` +
        `Error: \`${this._escapeMd(err.message)}\`\n\n` +
        `Could not login to the panel. Please make sure the URL, username, password, and path settings are correct and try again.`,
        {
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [
              [{ text: '🔄 Try Again', callback_data: 'add_panel_start' }],
              [{ text: '🎛️ Panel Settings', callback_data: 'admin_panel_settings' }]
            ]
          }
        }
      );
    }

    if (loadingMsg) {
      try {
        await this._apiCall('deleteMessage', { chat_id: userId, message_id: loadingMsg.message_id });
      } catch (e) { }
    }
  }

  // ==========================================
  // Custom Number Upload Logic
  // ==========================================

  async _showUploadAppSelect(userId, messageId) {
    const apps = require('../config').SUPPORTED_APPS;
    const rows = [];
    for (let i = 0; i < apps.length; i += 2) {
      const row = [];
      row.push({ text: apps[i].emoji + ' ' + apps[i].name, callback_data: 'up_app:' + apps[i].id });
      if (i + 1 < apps.length) {
        row.push({ text: apps[i + 1].emoji + ' ' + apps[i + 1].name, callback_data: 'up_app:' + apps[i + 1].id });
      }
      rows.push(row);
    }
    rows.push([{ text: '❌ Cancel', callback_data: 'up_cancel' }], [{ text: '📊 View Uploaded Numbers', callback_data: 'admin_view_mapping' }]);

    await this._safeEdit(userId, messageId,
      '*Admin Number Upload*\n\nSelect an app to upload custom numbers for:',
      {
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: rows }
      }
    );
  }

  async _promptFileUpload(userId, appId, messageId) {
    const app = require('../config').SUPPORTED_APPS.find(a => a.id === appId);
    if (!app) return;

    this._rangeAddState.set(userId, { type: 'upload_numbers', appId });

    await this._safeEdit(userId, messageId,
      '*Upload Numbers for ' + app.name + '*\n\nPlease upload a `.txt` file containing phone numbers.\nFormat: one number per line (e.g. `8801816824894`).',
      {
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: [[{ text: '❌ Cancel', callback_data: 'up_cancel' }]] }
      }
    );
  }

  async _handleDocumentUpload(msg) {
    const userId = msg.from.id;
    if (!this._isAdmin(userId)) return;

    const state = this._rangeAddState.get(userId);
    if (!state || state.type !== 'upload_numbers') return;

    const doc = msg.document;
    if (!doc.file_name.endsWith('.txt')) {
      await this._safeSend(userId, '❌ Please upload a valid `.txt` file.');
      return;
    }

    try {
      const fileId = doc.file_id;
      const fileUrl = await this.bot.getFileLink(fileId);
      const axios = require('axios');
      const response = await axios.get(fileUrl, { responseType: 'text' });
      const text = response.data;

      const numbers = text.split('\n')
        .map(n => n.replace(/\D/g, ''))
        .filter(n => n.length > 5);

      if (numbers.length === 0) {
        await this._safeSend(userId, '❌ No valid numbers found in the file.');
        return;
      }

      const db = require('../database');
      const insert = db.prepare('INSERT OR IGNORE INTO custom_numbers (app_id, phone_number) VALUES (?, ?)');

      const insertMany = db.transaction((numbers) => {
        for (const num of numbers) {
          insert.run(state.appId, num);
        }
      });
      insertMany(numbers);

      const app = require('../config').SUPPORTED_APPS.find(a => a.id === state.appId);
      await this._safeSend(userId, `✅ **Upload Complete!**\n\nSuccessfully processed ${numbers.length} numbers for ${app.name}.\n\n📎 *You can upload another .txt file for this app, or click Back to finish.*`, {
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: [[{ text: '« Back', callback_data: 'admin_range_add' }]] }
      });

    } catch (error) {
      console.error(`Upload error: ${error.message}`);
      await this._safeSend(userId, '❌ Error processing file.');
    }
  }

  async _showCurrentMapping(userId, messageId) {
    const db = require('../database');
    const apps = require('../config').SUPPORTED_APPS;

    let text = '*📊 Custom Numbers Status*\n\n';

    const rows = db.prepare('SELECT app_id, COUNT(*) as total, SUM(is_used) as used FROM custom_numbers GROUP BY app_id').all();

    if (rows.length === 0) {
      text += 'No custom numbers uploaded yet.';
    } else {
      for (const r of rows) {
        const app = apps.find(a => a.id === r.app_id);
        const appName = app ? app.name : r.app_id;
        const available = r.total - (r.used || 0);
        text += `📱 **${appName}**: ${available} available (out of ${r.total})\n`;
      }
    }

    const kb = [];
    for (const r of rows) {
      const app = apps.find(a => a.id === r.app_id);
      const appName = app ? app.name : r.app_id;
      kb.push([{ text: '📱 ' + appName, callback_data: 'up_view_countries:' + r.app_id }]);
    }
    kb.push([{ text: '« Back', callback_data: 'admin_range_add' }]);

    await this._safeEdit(userId, messageId, text, {
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: kb }
    });
  }

  async _showCountriesForApp(userId, appId, messageId) {
    const db = require('../database');
    const apps = require('../config').SUPPORTED_APPS;
    const app = apps.find(a => a.id === appId);
    const appName = app ? app.name : appId;

    const dbNums = db.prepare('SELECT phone_number, is_used FROM custom_numbers WHERE app_id = ?').all(appId);

    if (dbNums.length === 0) {
      await this._safeEdit(userId, messageId, `No numbers found for *${appName}*.`, {
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: [[{ text: '« Back to Status', callback_data: 'admin_view_mapping' }]] }
      });
      return;
    }

    const countryGroups = {};
    for (const row of dbNums) {
      const cInfo = this._getCountryInfo(row.phone_number);
      const countryName = cInfo && cInfo.name !== 'Unknown' ? cInfo.name : 'Custom';
      const flag = cInfo ? cInfo.flag : '🌐';

      if (!countryGroups[countryName]) {
        countryGroups[countryName] = {
          flag: flag,
          total: 0,
          used: 0
        };
      }

      countryGroups[countryName].total++;
      if (row.is_used) {
        countryGroups[countryName].used++;
      }
    }

    let text = `*🌍 Countries for ${appName}*\n\nChoose a country to clear numbers:\n\n`;
    const kb = [];

    for (const [cName, cInfo] of Object.entries(countryGroups)) {
      const available = cInfo.total - cInfo.used;
      text += `${cInfo.flag} **${cName}**: ${available} available (out of ${cInfo.total})\n`;
      kb.push([{
        text: `${cInfo.flag} Clear ${cName} (${available})`,
        callback_data: `up_clr_c:${appId}:${cName}`
      }]);
    }

    kb.push([{ text: '« Back', callback_data: 'admin_view_mapping' }]);

    await this._safeEdit(userId, messageId, text, {
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: kb }
    });
  }

  // ============================================================
  // DATA STATISTICS HANDLERS
  // ============================================================

  async _handleStats(msg) {
    const userId = msg.from.id;
    if (!this._isAdmin(userId)) {
      await this._safeSend(userId, '⛔ This command can only be used by admin.');
      return;
    }

    const localOffsetHours = config.TIMEZONE_OFFSET !== undefined ? config.TIMEZONE_OFFSET : (-new Date().getTimezoneOffset() / 60);
    const sign = localOffsetHours >= 0 ? '+' : '';
    const offsetString = `${sign}${localOffsetHours} hours`;
    const localDate = new Date(Date.now() + localOffsetHours * 3600000).toISOString().split('T')[0];

    let todayLogs = [];
    try {
      todayLogs = db.prepare(`
        SELECT panel_name, app_id, phone_number, otp_code 
        FROM otp_logs 
        WHERE date(received_at, ?) = ?
      `).all(offsetString, localDate);
    } catch (err) {
      console.error('Error fetching today logs:', err.message);
    }

    const text = this._getStatsText(todayLogs, localDate);

    const kb = [
      [
        { text: '🔄 Refresh', callback_data: 'refresh_stats' },
        { text: '🏠 Main Menu', callback_data: 'main_menu' }
      ]
    ];

    await this._safeSend(userId, text, {
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: kb }
    });
  }

  async _showDataStats(userId, messageId) {
    const localOffsetHours = config.TIMEZONE_OFFSET !== undefined ? config.TIMEZONE_OFFSET : (-new Date().getTimezoneOffset() / 60);
    const sign = localOffsetHours >= 0 ? '+' : '';
    const offsetString = `${sign}${localOffsetHours} hours`;
    const localDate = new Date(Date.now() + localOffsetHours * 3600000).toISOString().split('T')[0];

    let todayLogs = [];
    try {
      todayLogs = db.prepare(`
        SELECT panel_name, app_id, phone_number, otp_code 
        FROM otp_logs 
        WHERE date(received_at, ?) = ?
      `).all(offsetString, localDate);
    } catch (err) {
      console.error('Error fetching today logs:', err.message);
    }

    const text = this._getStatsText(todayLogs, localDate);

    const kb = [
      [
        { text: '🔄 Refresh', callback_data: 'refresh_stats' },
        { text: '🏠 Main Menu', callback_data: 'main_menu' }
      ]
    ];

    await this._safeEdit(userId, messageId, text, {
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: kb }
    });
  }

  _getStatsText(todayLogs, localDate) {
    const totalOtpCount = todayLogs.length;
    // Unique OTPs globally = unique (phone_number, app_id) combinations
    const uniqueNumsSet = new Set(todayLogs.map(l => `${l.phone_number}_${l.app_id}`));

    const panelStats = new Map();
    const appStats = new Map();

    const appEmojis = {
      'facebook': '📘',
      'whatsapp': '🟢',
      'instagram': '📸',
      'tiktok': '🎵',
      'telegram': '✈️',
      'unknown': '❓'
    };

    const getAppEmoji = (id) => appEmojis[id.toLowerCase()] || '📦';
    const capitalize = (str) => str.charAt(0).toUpperCase() + str.slice(1);

    for (const log of todayLogs) {
      const panel = log.panel_name || 'Unknown';
      const app = log.app_id || 'Unknown';
      const num = log.phone_number;

      if (!panelStats.has(panel)) {
        panelStats.set(panel, { 
          total: 0, 
          uniqueNumbers: new Set(),
          apps: {} 
        });
      }
      const pStat = panelStats.get(panel);
      pStat.total++;
      // Unique numbers for panel = unique (phone_number, app_id) combinations
      pStat.uniqueNumbers.add(`${num}_${app}`);
      
      const appIdLower = app.toLowerCase();
      pStat.apps[appIdLower] = (pStat.apps[appIdLower] || 0) + 1;

      if (!appStats.has(app)) {
        appStats.set(app, { total: 0, uniqueNumbers: new Set() });
      }
      const aStat = appStats.get(app);
      aStat.total++;
      // For a specific app, uniqueNumbers is just unique phone numbers since app_id is constant
      aStat.uniqueNumbers.add(num);
    }

    let text = `📊 *Today's OTP Overview*\n`;
    text += `📅 *Date:* \`${localDate}\`\n\n`;
    text += `🔹 *Total Received:* **${totalOtpCount}**\n`;
    text += `🔹 *Unique Numbers:* **${uniqueNumsSet.size}**\n\n`;

    text += `🖥️ *Stats by Panel*\n`;
    text += `━━━━━━━━━━━━━━━━━━━━━━\n`;
    if (panelStats.size === 0) {
      text += `_No OTPs received today._\n\n`;
    } else {
      for (const [panelName, stat] of panelStats) {
        text += `🏢 *${this._escapeMd(panelName)}* • ${stat.total} OTPs (${stat.uniqueNumbers.size} unique)\n`;
        
        let otherCount = 0;
        const supportedIds = config.SUPPORTED_APPS.map(a => a.id.toLowerCase());
        const lines = [];
        
        for (const appInfo of config.SUPPORTED_APPS) {
          const count = stat.apps[appInfo.id.toLowerCase()] || 0;
          lines.push({ name: appInfo.name, count, emoji: getAppEmoji(appInfo.id) });
        }
        
        for (const [aId, count] of Object.entries(stat.apps)) {
          if (!supportedIds.includes(aId) && aId.toLowerCase() !== 'unknown') {
            otherCount += count;
          }
        }
        if (stat.apps['unknown']) otherCount += stat.apps['unknown'];
        
        lines.push({ name: 'Other', count: otherCount, emoji: '❓' });
        
        lines.forEach((line, index) => {
          const prefix = index === lines.length - 1 ? ' └' : ' ├';
          text += `${prefix} ${line.emoji} ${line.name}: ${line.count}\n`;
        });
        text += `\n`;
      }
    }

    text += `📦 *Overall App Breakdown*\n`;
    text += `━━━━━━━━━━━━━━━━━━━━━━\n`;
    if (appStats.size === 0) {
      text += `_No OTPs received today._\n`;
    } else {
      for (const [appId, stat] of appStats) {
        const appInfo = config.SUPPORTED_APPS.find(a => a.id === appId);
        const name = appInfo ? appInfo.name : capitalize(appId);
        const emoji = getAppEmoji(appId);
        text += `▪️ ${emoji} *${this._escapeMd(name)}*: ${stat.total} OTPs (${stat.uniqueNumbers.size} unique)\n`;
      }
    }

    return text;
  }

  _registerUser(userId, userName) {
    db.prepare(`
      INSERT OR IGNORE INTO user_sessions (telegram_user_id, telegram_username)
      VALUES (?, ?)
    `).run(userId, userName);
  }

  getBot() {
    return this.bot;
  }
}

module.exports = OTPBot;
