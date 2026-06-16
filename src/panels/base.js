// ============================================================
// BASE PANEL SCRAPER
// FIXED v2: Better timeout, proper headers, robust session management
// ============================================================

const axios = require('axios');
const cheerio = require('cheerio');
const { wrapper } = require('axios-cookiejar-support');
const { CookieJar } = require('tough-cookie');
const { solveMathCaptcha } = require('../utils/captcha-solver');

class BasePanel {
  constructor(config) {
    this.name = config.name;
    this.baseUrl = config.baseUrl.replace(/\/+$/, '');
    this.username = config.username;
    this.password = config.password;
    this.enabled = config.enabled;

    this.loginPageUrl = config.loginPageUrl || '/login';
    this.signinUrl = config.signinUrl || '/signin';
    this.dashboardPath = config.dashboardPath || '/agent';

    this._createHttpClient();

    this.isLoggedIn = false;
    this.lastLoginAttempt = null;
    this.loginFailures = 0;
  }

  _createHttpClient() {
    this.jar = new CookieJar();
    this.client = wrapper(axios.create({
      timeout: 15000,           // 15 second timeout (fast fail)
      validateStatus: () => true,
    }));
    this.client.defaults.jar = this.jar;
  }

  _url(path) {
    return `${this.baseUrl}${path}`;
  }

  // ============================================================
  // লগইন সিস্টেম
  // ============================================================
  async login(force = false) {
    if (this.isLoggedIn && !force) return true;

    if (this.loginFailures > 5 && !force) {
      const waitTime = Math.min(this.loginFailures * 30000, 300000);
      console.log(`[${this.name}] Too many failures. Waiting ${waitTime / 1000}s...`);
      await new Promise(r => setTimeout(r, waitTime));
    }

    try {
      const loginUrl = this._url(this.loginPageUrl);
      const signinUrl = this._url(this.signinUrl);
      console.log(`[${this.name}] Logging in...`);

      // ধাপ ১: লগইন পেজ ফেচ
      const loginPage = await this.client.get(loginUrl, {
        maxRedirects: 5,
        headers: this._headers()
      });

      console.log(`[${this.name}] Login page status: ${loginPage.status}`);
      const html = typeof loginPage.data === 'string' ? loginPage.data : JSON.stringify(loginPage.data);

      // ক্যাপচা সলভ
      const captcha = solveMathCaptcha(html);
      if (!captcha) {
        console.error(`[${this.name}] CAPTCHA not found in login page!`);
        this.loginFailures++;
        return false;
      }
      console.log(`[${this.name}] CAPTCHA: ${captcha.question} = ${captcha.answer}`);

      // ধাপ ২: লগইন POST
      // maxRedirects: 5 — axios auto-follow redirect, cookie jar properly saves cookies
      const loginData = new URLSearchParams({
        username: this.username,
        password: this.password,
        capt: String(captcha.answer)
      });

      const response = await this.client.post(signinUrl, loginData.toString(), {
        maxRedirects: 5,
        headers: {
          ...this._headers(),
          'Content-Type': 'application/x-www-form-urlencoded',
          'Referer': loginUrl,
          'Origin': this.baseUrl
        }
      });

      console.log(`[${this.name}] Login final status: ${response.status}`);
      console.log(`[${this.name}] Final URL: ${response.request?.res?.responseUrl || 'unknown'}`);

      const body = typeof response.data === 'string' ? response.data : JSON.stringify(response.data);

      // রেসপন্স বডি চেক — লগইন পেজ থাকলে ব্যর্থ
      if (body.includes('Username/Password Invalid') || body.includes('Invalid') || (body.includes('invalid') && body.includes('Username'))) {
        console.error(`[${this.name}] LOGIN FAILED: Wrong credentials`);
        this.loginFailures++;
        return false;
      }

      // Login page detection: BOTH "What is" (CAPTCHA) AND "type=password" (login form)
      // Dashboard page may also have type=password in change-password form, so check for CAPTCHA too
      if (body.includes('What is') && body.includes('type="password"') && body.includes('type="text"')) {
        console.error(`[${this.name}] LOGIN FAILED: Still on login page (CAPTCHA page)`);
        this.loginFailures++;
        return false;
      }

      // 200 — dashboard page loaded directly (redirect auto-followed by axios)
      // Note: dashboard page may contain type=password (change-password form), so DON'T check for that
      if (response.status === 200) {
        this.isLoggedIn = true;
        this.loginFailures = 0;
        this.lastLoginAttempt = new Date();
        console.log(`[${this.name}] LOGIN SUCCESS (200 - auto-redirect)`);
        return true;
      }

      // 302/301/303 — redirect ম্যানুয়ালি follow করা লাগতে পারে (rare case)
      if (response.status === 302 || response.status === 301 || response.status === 303) {
        const redirectLocation = response.headers?.location || response.headers?.Location || '';
        console.log(`[${this.name}] Manual redirect to: ${redirectLocation}`);

        try {
          const redirectUrl = new URL(redirectLocation, signinUrl).href;
          await this.client.get(redirectUrl, {
            maxRedirects: 5,
            headers: this._headers()
          });
        } catch (followErr) {
          console.log(`[${this.name}] Redirect follow warning: ${followErr.message}`);
        }

        // Dashboard verify
        try {
          const dashUrl = this._url(this.dashboardPath);
          const dashResp = await this.client.get(dashUrl, {
            maxRedirects: 5,
            headers: this._headers()
          });
          const dashBody = typeof dashResp.data === 'string' ? dashResp.data : '';
          // Login page has CAPTCHA ("What is") + password + text fields
          if (dashBody.includes('What is') && dashBody.includes('type="password"') && dashBody.includes('type="text"')) {
            console.error(`[${this.name}] Dashboard still shows login page after redirect!`);
            this.loginFailures++;
            return false;
          }
          console.log(`[${this.name}] Dashboard loaded OK (status ${dashResp.status})`);
        } catch (dashErr) {
          console.log(`[${this.name}] Dashboard check error: ${dashErr.message}`);
        }

        this.isLoggedIn = true;
        this.loginFailures = 0;
        this.lastLoginAttempt = new Date();
        console.log(`[${this.name}] LOGIN SUCCESS (manual redirect)`);
        return true;
      }

      // অন্য সব 2xx status — সম্ভবত সফল
      if (response.status >= 200 && response.status < 300) {
        this.isLoggedIn = true;
        this.loginFailures = 0;
        this.lastLoginAttempt = new Date();
        console.log(`[${this.name}] LOGIN SUCCESS (status ${response.status})`);
        return true;
      }

      console.error(`[${this.name}] LOGIN FAILED: Unexpected status ${response.status}`);
      this.loginFailures++;
      return false;

    } catch (error) {
      console.error(`[${this.name}] Login ERROR: ${error.message}`);
      this.loginFailures++;
      this.isLoggedIn = false;
      return false;
    }
  }

  _headers() {
    return {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
    };
  }

  async logout() {
    this.isLoggedIn = false;
    this._createHttpClient();
    console.log(`[${this.name}] Logged out`);
  }

  async fetchPage(pagePath) {
    if (!this.isLoggedIn) {
      const loggedIn = await this.login();
      if (!loggedIn) return null;
    }

    try {
      const fullPath = `${this.dashboardPath}/${pagePath}`.replace(/\/+/g, '/');
      const url = this._url(fullPath);
      console.log(`[${this.name}] Fetching: ${url}`);

      const response = await this.client.get(url, {
        maxRedirects: 5,
        headers: this._headers()
      });

      console.log(`[${this.name}] Fetch status: ${response.status}`);

      const body = typeof response.data === 'string' ? response.data : '';
      if (body.includes('type="password"') && body.includes('What is')) {
        console.log(`[${this.name}] Session expired, re-logging in...`);
        this.isLoggedIn = false;
        const loggedIn = await this.login(true);
        if (!loggedIn) return null;

        const retry = await this.client.get(url, {
          maxRedirects: 5,
          headers: this._headers()
        });
        return {
          html: typeof retry.data === 'string' ? retry.data : JSON.stringify(retry.data),
          status: retry.status,
          url: url
        };
      }

      return {
        html: typeof response.data === 'string' ? response.data : JSON.stringify(response.data),
        status: response.status,
        url: url
      };

    } catch (error) {
      console.error(`[${this.name}] Fetch error [${pagePath}]: ${error.message}`);
      return null;
    }
  }

  async getAvailableNumbers(appId) {
    console.log(`[${this.name}] getAvailableNumbers: ${appId}`);
    return [];
  }

  async getNewMessages(phoneNumber) {
    console.log(`[${this.name}] getNewMessages: ${phoneNumber}`);
    return [];
  }

  getStatus() {
    return {
      name: this.name,
      isLoggedIn: this.isLoggedIn,
      lastLogin: this.lastLoginAttempt,
      failures: this.loginFailures,
      enabled: this.enabled
    };
  }
}

module.exports = BasePanel;
