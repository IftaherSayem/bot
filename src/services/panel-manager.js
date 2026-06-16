// ============================================================
// প্যানেল ম্যানেজার - সব প্যানেল একসাথে ম্যানেজ করা
// v3: APP_NUMBER_MAPPING ভিত্তিক নাম্বর ফেচিং
// v8.2: getAvailableRangesForApp() — country button জন্য
// ============================================================

const WolfSMSPanel = require('../panels/wolf-sms');
const insPanel = require('../panels/inspanel');
const purplePanel = require('../panels/purplepanel');
const config = require('../../config');
const db = require('../../database');

class PanelManager {
  constructor() {
    this.panels = [];
    this._initPanels();
    this._cache = {
      ranges: {},
      numbers: {}
    };
    this.CACHE_TTL = 60000; // 60 seconds cache (fast button response)
  }

  _initPanels() {
    // Load config panels
    for (const panelConfig of config.PANELS) {
      let type = panelConfig.type;
      if (!type) {
        if (panelConfig.signinUrl && panelConfig.signinUrl.includes('/api/')) {
          type = 'ins';
        } else if (panelConfig.signinUrl && (panelConfig.signinUrl.includes('signmein') || panelConfig.loginPageUrl?.includes('SignIn'))) {
          type = 'purple';
        } else {
          type = 'wolf';
        }
      }

      let panel;
      if (type === 'ins' || type === 'api') {
        panel = new insPanel(panelConfig);
      } else if (type === 'purple') {
        panel = new purplePanel(panelConfig);
      } else {
        panel = new WolfSMSPanel(panelConfig);
      }

      this.panels.push(panel);
      console.log(`Panel loaded: ${panel.name} (${panel.baseUrl}, Type: ${type})`);
    }

    // Load dynamic panels from SQLite database
    try {
      const rows = db.prepare('SELECT * FROM dynamic_panels').all();
      for (const row of rows) {
        const panelConfig = {
          name: row.name,
          baseUrl: row.base_url,
          loginPageUrl: row.login_page_url,
          signinUrl: row.signin_url,
          dashboardPath: row.dashboard_path,
          username: row.username,
          password: row.password,
          enabled: row.is_enabled === 1,
          type: row.type
        };

        let type = panelConfig.type;
        if (!type) {
          if (panelConfig.signinUrl && panelConfig.signinUrl.includes('/api/')) {
            type = 'ins';
          } else if (panelConfig.signinUrl && (panelConfig.signinUrl.includes('signmein') || panelConfig.loginPageUrl?.includes('SignIn'))) {
            type = 'purple';
          } else {
            type = 'wolf';
          }
        }

        let panel;
        if (type === 'ins' || type === 'api') {
          panel = new insPanel(panelConfig);
        } else if (type === 'purple') {
          panel = new purplePanel(panelConfig);
        } else {
          panel = new WolfSMSPanel(panelConfig);
        }

        this.panels.push(panel);
        console.log(`Dynamic Panel loaded: ${panel.name} (${panel.baseUrl}, Type: ${type})`);
      }
    } catch (e) {
      console.error('Failed to load dynamic panels from database:', e.message);
    }
  }

  isPanelEnabled(panelName) {
    try {
      const row = db.prepare('SELECT is_enabled FROM panel_settings WHERE panel_name = ?').get(panelName);
      if (row) return row.is_enabled === 1;
      
      const dynRow = db.prepare('SELECT is_enabled FROM dynamic_panels WHERE name = ?').get(panelName);
      if (dynRow) return dynRow.is_enabled === 1;

      // Fallback to config.js if not set in DB
      const pConf = config.PANELS.find(p => p.name === panelName);
      if (pConf) return pConf.enabled;
      
      return true;
    } catch (e) {
      return true;
    }
  }

  getActivePanels() {
    return this.panels.filter(p => this.isPanelEnabled(p.name));
  }

  // ---- সব প্যানেল লগইন ----
  async loginAll() {
    console.log('=== Logging in to all panels concurrently ===');
    
    const promises = this.getActivePanels().map(async (panel) => {
      try {
        const success = await panel.login();
        if (!success) {
          console.error(`Failed to login to ${panel.name}`);
        }
        return { name: panel.name, success };
      } catch (error) {
        return { name: panel.name, success: false, error: error.message };
      }
    });

    const results = await Promise.all(promises);

    console.log(`Login results: ${results.filter(r => r.success).length}/${results.length} successful`);
    return results;
  }

  // ---- একটি নির্দিষ্ট প্যানেল লগইন (live activate এর জন্য) ----
  async loginPanel(panelName) {
    const panel = this.panels.find(p => p.name === panelName);
    if (!panel) {
      console.error(`[loginPanel] Panel not found: ${panelName}`);
      return false;
    }
    try {
      console.log(`[loginPanel] Logging in to ${panelName}...`);
      const success = await panel.login(true);
      console.log(`[loginPanel] ${panelName}: ${success ? 'SUCCESS' : 'FAILED'}`);
      return success;
    } catch (e) {
      console.error(`[loginPanel] ${panelName} error: ${e.message}`);
      return false;
    }
  }

  // ============================================================
  // ম্যাপিং চেক — এই অ্যাপের জন্য কোনো range mapping আছে কিনা
  // ============================================================
  hasMappingForApp(appId) {
    const mapping = config.APP_NUMBER_MAPPING && config.APP_NUMBER_MAPPING[appId];
    if (!mapping || mapping.length === 0) return false;

    // কমপক্ষে একটি entry তে প্যানেল ও range থাকতে হবে
    return mapping.some(m => m.panel && m.range);
  }

  // ============================================================
  // অ্যাপের জন্য range list আনা (country button দেখানোর জন্য)
  // Returns: [{ range, count, panel, price }, ...] — sorted by count desc
  // ============================================================
  async getAvailableRangesForApp(appId) {
    const now = Date.now();
    const cacheEntry = this._cache.ranges[appId];

    if (cacheEntry) {
      if (now - cacheEntry.timestamp > this.CACHE_TTL && !cacheEntry.isFetching) {
        cacheEntry.isFetching = true;
        this._fetchRanges(appId).then(data => {
          this._cache.ranges[appId] = { timestamp: Date.now(), data, isFetching: false };
        }).catch(err => {
          console.error('[PanelManager] Background fetch failed', err);
          cacheEntry.isFetching = false;
        });
      }
      return cacheEntry.data;
    }

    const data = await this._fetchRanges(appId);
    this._cache.ranges[appId] = { timestamp: Date.now(), data, isFetching: false };
    return data;
  }

  async _fetchRanges(appId) {
    const mapping = config.APP_NUMBER_MAPPING && config.APP_NUMBER_MAPPING[appId];
    if (!mapping || mapping.length === 0) return [];

    const rangeMap = new Map();
    const promises = mapping.map(async (entry) => {
      if (!entry.panel || !entry.range) return;
      const panel = this.getActivePanels().find(p => p.name === entry.panel);
      if (!panel || !panel.isLoggedIn) return;

      try {
        const numbers = await panel.getAvailableNumbers(appId);
        const rangeLower = entry.range.toLowerCase();

        for (const num of numbers) {
          const numRange = (num.range || '').toLowerCase();
          if (!numRange.includes(rangeLower)) continue;

          const normalized = num.number.replace(/[\s\-\+]/g, '');
          const alreadyAllocated = this._isNumberAllocated(normalized);
          if (alreadyAllocated) continue;

          const actualRange = num.range || entry.range;
          if (!rangeMap.has(actualRange)) {
            rangeMap.set(actualRange, { count: 0, panel: entry.panel, price: num.payout || '' });
          }
          rangeMap.get(actualRange).count++;
        }
      } catch (error) {
        console.error(`[PanelManager] getAvailableRanges error from ${entry.panel}: ${error.message}`);
      }
    });

    await Promise.all(promises);

    const result = [];
    for (const [range, info] of rangeMap) {
      result.push({ range, count: info.count, panel: info.panel, price: info.price });
    }
    result.sort((a, b) => b.count - a.count);
    return result;
  }

  // ---- allocated নাম্বার চেক (inline, no circular dependency) ----
  _isNumberAllocated(normalizedNumber) {
    try {
      const row = db.prepare(`
        SELECT 1 FROM number_allocations
        WHERE status = 'active' AND phone_number LIKE ?
      `).get(`%${normalizedNumber.slice(-10)}%`);
      return !!row;
    } catch (e) {
      return false;
    }
  }

  // ============================================================
  // অ্যাপের জন্য নাম্বর আনা — নির্দিষ্ট range দিয়ে filter
  // specificRange থাকলে শুধু সেই range এর নাম্বর আসবে
  // ============================================================
  async getNumbersForApp(appId, specificRange = null) {
    const cacheKey = appId + "_" + (specificRange || "ALL");
    const now = Date.now();
    if (this._cache.numbers[cacheKey] && (now - this._cache.numbers[cacheKey].timestamp < this.CACHE_TTL)) {
      return this._cache.numbers[cacheKey].data;
    }

    const mapping = config.APP_NUMBER_MAPPING && config.APP_NUMBER_MAPPING[appId];

    if (!mapping || mapping.length === 0) {
      console.log(`[PanelManager] No mapping for app: ${appId}`);
      return [];
    }

    const promises = mapping.map(async (entry) => {
      if (!entry.panel || !entry.range) return [];

      if (specificRange) {
        const entryLower = entry.range.toLowerCase();
        const specificLower = specificRange.toLowerCase();
        if (!specificLower.includes(entryLower) && !entryLower.includes(specificLower)) {
          return [];
        }
      }

      const panel = this.getActivePanels().find(p => p.name === entry.panel);
      if (!panel) {
        console.error(`[PanelManager] Panel "${entry.panel}" not found for app ${appId}`);
        return [];
      }

      try {
        const numbers = await panel.getAvailableNumbers(appId);
        let rangeFilter = specificRange || entry.range;
        const rangeLower = rangeFilter.toLowerCase();
        const filtered = numbers.filter(num => {
          const numRange = (num.range || '').toLowerCase();
          return numRange.includes(rangeLower);
        });
        console.log(`[PanelManager] ${entry.panel} + "${rangeFilter}" -> ${filtered.length} numbers (from ${numbers.length} total)`);
        return filtered;
      } catch (error) {
        console.error(`[PanelManager] Error from ${entry.panel}: ${error.message}`);
        try {
          await panel.login(true);
          const numbers = await panel.getAvailableNumbers(appId);
          let rangeFilter = specificRange || entry.range;
          const rangeLower = rangeFilter.toLowerCase();
          const filtered = numbers.filter(num => {
            const numRange = (num.range || '').toLowerCase();
            return numRange.includes(rangeLower);
          });
          return filtered;
        } catch (retryError) {
          console.error(`[PanelManager] Retry failed for ${entry.panel}: ${retryError.message}`);
          return [];
        }
      }
    });

    const results = await Promise.all(promises);
    const allNumbers = results.flat();

    const uniqueNumbers = [];
    const seenNumbers = new Set();
    for (const num of allNumbers) {
      const normalized = num.number.replace(/[\s\-\+]/g, '');
      if (!seenNumbers.has(normalized)) {
        seenNumbers.add(normalized);
        uniqueNumbers.push(num);
      }
    }

    console.log(`[PanelManager] App ${appId}${specificRange ? ' range=' + specificRange : ''}: ${uniqueNumbers.length} unique numbers`);
    return uniqueNumbers;
  }

  // ============================================================
  // সব প্যানেল থেকে সব range আনা (admin /ranges কমান্ড)
  // Returns: { panelName: [{ range, count }, ...] }
  // ============================================================
  async getAllRanges() {
    const result = {};

    const promises = this.getActivePanels().map(async (panel) => {
      if (!panel.isLoggedIn) return { name: panel.name, ranges: [] };
      try {
        console.log(`[PanelManager] Fetching ranges from ${panel.name}...`);
        const ranges = await panel.getAllRanges();
        return { name: panel.name, ranges };
      } catch (error) {
        console.error(`[PanelManager] Error getting ranges from ${panel.name}: ${error.message}`);
        return { name: panel.name, ranges: [] };
      }
    });

    const results = await Promise.all(promises);
    for (const r of results) {
      result[r.name] = r.ranges;
    }

    return result;
  }

  // ---- নির্দিষ্ট নাম্বারের জন্য SMS চেক (সব প্যানেলে) ----
  async checkMessagesForNumber(phoneNumber) {
    const promises = this.getActivePanels().map(async (panel) => {
      try {
        return await panel.getNewMessages(phoneNumber);
      } catch (error) {
        console.error(`Error checking ${panel.name} for ${phoneNumber}: ${error.message}`);
        return [];
      }
    });

    const results = await Promise.all(promises);
    return results.flat();
  }

  // ---- নির্দিষ্ট প্যানেল থেকে সব মেসেজ আনা (OTP monitoring) ----
  async getAllMessages(panelName) {
    const panel = this.getActivePanels().find(p => p.name === panelName);
    if (!panel) return [];

    // Auto-login if enabled but not currently logged in (e.g. was just activated)
    if (!panel.isLoggedIn) {
      try {
        await panel.login(true);
      } catch(e) {}
      if (!panel.isLoggedIn) return [];
    }

    try {
      return await panel.getNewMessages('all');
    } catch (error) {
      console.error(`Error getting messages from ${panelName}: ${error.message}`);
      try {
        await panel.login(true);
        return await panel.getNewMessages('all');
      } catch (retryError) {
        return [];
      }
    }
  }

  // ---- প্যানেল স্ট্যাটাস ----
  getStatus() {
    return this.panels.map(p => {
      const status = p.getStatus();
      status.isEnabled = this.isPanelEnabled(p.name);
      status.isDynamic = !config.PANELS.some(cp => cp.name === p.name);
      return status;
    });
  }

  // ---- নতুন প্যানেল যোগ করা ----
  async addPanel(panelConfig) {
    // ১. প্যানেল ইন্সট্যান্স তৈরি করো টেস্ট করার জন্য
    let type = panelConfig.type;
    if (!type) {
      if (panelConfig.signinUrl && panelConfig.signinUrl.includes('/api/')) {
        type = 'ins';
      } else if (panelConfig.signinUrl && (panelConfig.signinUrl.includes('signmein') || panelConfig.loginPageUrl?.includes('SignIn'))) {
        type = 'purple';
      } else {
        type = 'wolf';
      }
    }

    let panel;
    if (type === 'ins' || type === 'api') {
      panel = new insPanel(panelConfig);
    } else if (type === 'purple') {
      panel = new purplePanel(panelConfig);
    } else {
      panel = new WolfSMSPanel(panelConfig);
    }

    // ২. লগইন টেস্ট করো
    const loggedIn = await panel.login(true);
    if (!loggedIn) {
      throw new Error('Login validation failed. Please check credentials or website URL.');
    }

    // ৩. ডাটাবেসে সেভ করো
    db.prepare(`
      INSERT INTO dynamic_panels (name, base_url, login_page_url, signin_url, dashboard_path, username, password, is_enabled, type)
      VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)
    `).run(
      panelConfig.name,
      panelConfig.baseUrl,
      panelConfig.loginPageUrl || (type === 'ins' ? '/api/auth/login' : (type === 'purple' ? '/sms/SignIn' : '/ints/login')),
      panelConfig.signinUrl || (type === 'ins' ? '/api/auth/login' : (type === 'purple' ? '/sms/signmein' : '/ints/signin')),
      panelConfig.dashboardPath || (type === 'ins' ? '' : (type === 'purple' ? '/sms/reseller/MyNotifications' : '/ints/agent')),
      panelConfig.username,
      panelConfig.password,
      type
    );

    // ৪. লাইভ প্যানেল লিস্টে যুক্ত করো
    this.panels.push(panel);
    console.log(`[PanelManager] Dynamic panel added successfully: ${panel.name} (Type: ${type})`);
    return true;
  }

  // ---- প্যানেল মুছে ফেলা ----
  removePanel(name) {
    // সিস্টেম প্যানেল কিনা চেক করো
    const isConfigPanel = config.PANELS.some(p => p.name === name);
    if (isConfigPanel) {
      throw new Error('Cannot delete system panels defined in config.js');
    }

    // ডাটাবেস থেকে মুছুন
    db.prepare('DELETE FROM dynamic_panels WHERE name = ?').run(name);
    db.prepare('DELETE FROM panel_settings WHERE panel_name = ?').run(name);

    // লাইভ লিস্ট থেকে সরান
    const idx = this.panels.findIndex(p => p.name === name);
    if (idx !== -1) {
      this.panels[idx].logout().catch(() => {});
      this.panels.splice(idx, 1);
    }

    console.log(`[PanelManager] Dynamic panel removed: ${name}`);
    return true;
  }
}

// সিঙ্গেলটন
module.exports = new PanelManager();
