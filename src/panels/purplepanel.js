// ============================================================
// PURPLE SMS PANEL CLIENT
// v2: Fixed OTP endpoint to use dt_whreports.php
// ============================================================

const BasePanel = require('./base');
const cheerio = require('cheerio');
const { solveMathCaptcha } = require('../utils/captcha-solver');

class purplePanel extends BasePanel {
  constructor(config) {
    // Set default endpoints if not provided
    config.loginPageUrl = config.loginPageUrl || '/sms/SignIn';
    config.signinUrl = config.signinUrl || '/sms/signmein';
    config.dashboardPath = config.dashboardPath || '/sms/reseller/MyNotifications';
    super(config);
    this._maxRetries = 2;
  }

  /**
   * Overridden login for Purple SMS Panel
   */
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
      console.log(`[${this.name}] Logging in (Purple SMS style)...`);

      // 1. Fetch Login Page
      const loginPage = await this.client.get(loginUrl, {
        maxRedirects: 5,
        headers: this._headers()
      });

      console.log(`[${this.name}] Login page status: ${loginPage.status}`);
      const html = typeof loginPage.data === 'string' ? loginPage.data : JSON.stringify(loginPage.data);

      // Solve Captcha
      const captcha = solveMathCaptcha(html);
      if (!captcha) {
        console.error(`[${this.name}] Math CAPTCHA not found in login page HTML`);
        this.loginFailures++;
        return false;
      }
      console.log(`[${this.name}] Solved CAPTCHA: ${captcha.question} = ${captcha.answer}`);

      // 2. Submit Login Form
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

      console.log(`[${this.name}] Login POST status: ${response.status}`);
      const finalUrl = response.request?.res?.responseUrl || '';
      console.log(`[${this.name}] Final URL after redirect: ${finalUrl}`);

      const body = typeof response.data === 'string' ? response.data : JSON.stringify(response.data);

      // Check for failure indications in response body
      if (body.includes('Username/Password Invalid') || body.includes('Invalid') || body.includes('Enter Answer')) {
        console.error(`[${this.name}] LOGIN FAILED: Wrong credentials or captcha error`);
        this.loginFailures++;
        return false;
      }

      // Check if we are still on sign-in page
      if (finalUrl.includes('SignIn') || body.includes('name="capt"')) {
        console.error(`[${this.name}] LOGIN FAILED: Redirected back to SignIn page`);
        this.loginFailures++;
        return false;
      }

      this.isLoggedIn = true;
      this.loginFailures = 0;
      this.lastLoginAttempt = new Date();
      console.log(`[${this.name}] LOGIN SUCCESS`);
      return true;
    } catch (e) {
      console.error(`[${this.name}] Login error: ${e.message}`);
      this.loginFailures++;
      this.isLoggedIn = false;
      return false;
    }
  }

  /**
   * Helper to format Date as YYYY-MM-DD HH:mm:ss
   */
  _formatDate(date) {
    const pad = num => String(num).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
  }

  /**
   * Helper to extract number ID from HTML
   */
  _extractId(htmlStr) {
    if (!htmlStr) return '';
    const match = htmlStr.match(/value=['"](\d+)['"]/i) || htmlStr.match(/info=['"](\d+)['"]/i);
    return match ? match[1] : '';
  }

  /**
   * Fetch available numbers list
   */
  async getAvailableNumbers(appId, retryCount = 0) {
    if (!this.isLoggedIn) {
      const ok = await this.login();
      if (!ok) return [];
    }

    const ajaxUrl = `${this.baseUrl}/sms/reseller/ajax/dt_numbers.php?ftermination=&fclient=&iDisplayLength=10000`;
    try {
      const res = await this.client.get(ajaxUrl, {
        headers: {
          ...this._headers(),
          'Referer': `${this.baseUrl}/sms/reseller/AssignedNumbers`,
          'X-Requested-With': 'XMLHttpRequest'
        }
      });

      const text = typeof res.data === 'string' ? res.data : JSON.stringify(res.data);

      // Session expired detection (login page elements in response)
      if (text.includes('name="capt"') || text.includes('SignIn') || text.includes('Direct Access not allowed')) {
        if (retryCount >= this._maxRetries) {
          console.error(`[${this.name}] Session expired during fetch. Max retries reached.`);
          return [];
        }
        console.log(`[${this.name}] Session expired, re-logging in (retry ${retryCount + 1}/${this._maxRetries})...`);
        this.isLoggedIn = false;
        await this.login(true);
        return this.getAvailableNumbers(appId, retryCount + 1);
      }

      let json;
      try {
        json = typeof res.data === 'object' ? res.data : JSON.parse(text);
      } catch (e) {
        console.error(`[${this.name}] Numbers AJAX response not JSON`);
        return [];
      }

      const numbers = [];
      const aaData = json.aaData || [];

      for (const row of aaData) {
        if (row.length >= 4) {
          // row[1] = Range, row[2] = Number, row[3] = Payout html, row[0] = Checkbox / ID
          let rangeName = row[1] || 'Unknown';
          const $r = cheerio.load(rangeName);
          rangeName = $r.text().trim();

          const number = String(row[2] || '').replace(/[\s\-\+]/g, '').trim();

          let payout = row[3] || '';
          if (payout) {
            const $p = cheerio.load(payout);
            payout = $p.text().trim();
          }

          if (number && number.length >= 8) {
            numbers.push({
              number: number,
              range: rangeName,
              prefix: '',
              panel: this.name,
              payout: payout,
              id: this._extractId(row[0])
            });
          }
        }
      }

      return numbers;
    } catch (e) {
      console.error(`[${this.name}] getAvailableNumbers error: ${e.message}`);
      return [];
    }
  }

  /**
   * Fetch all ranges with number counts
   */
  async getAllRanges() {
    const numbers = await this.getAvailableNumbers();
    const rangeMap = {};

    numbers.forEach(num => {
      const rName = num.range || 'Unknown';
      rangeMap[rName] = (rangeMap[rName] || 0) + 1;
    });

    return Object.entries(rangeMap).map(([range, count]) => ({
      range,
      count
    }));
  }

  /**
   * Fetch new messages / OTPs
   */
  async getNewMessages(phoneNumber = 'all', retryCount = 0) {
    if (!this.isLoggedIn) {
      const ok = await this.login();
      if (!ok) return [];
    }

    // Prepare date range: 24 hours back to now (WhReports keeps today's SMS)
    const now = new Date();
    const start = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const end = new Date(now.getTime() + 1 * 60 * 60 * 1000);

    const fdate1 = encodeURIComponent(this._formatDate(start));
    const fdate2 = encodeURIComponent(this._formatDate(end));

    // Optional phone number filter
    const filterNum = phoneNumber === 'all' ? '' : encodeURIComponent(phoneNumber.replace(/[\s\-\+]/g, ''));

    // Correct endpoint: dt_whreports.php (WhatsApp/SMS reports with message body)
    const ajaxUrl = `${this.baseUrl}/sms/reseller/ajax/dt_whreports.php?fdate1=${fdate1}&fdate2=${fdate2}&frange=&fnum=${filterNum}&fcli=&fgdate=0&fgrange=0&fgnumber=0&fgcli=0&fg=0&iDisplayLength=500`;

    try {
      const res = await this.client.get(ajaxUrl, {
        headers: {
          ...this._headers(),
          'Referer': `${this.baseUrl}/sms/reseller/WhReports`,
          'X-Requested-With': 'XMLHttpRequest'
        }
      });

      const text = typeof res.data === 'string' ? res.data : JSON.stringify(res.data);

      if (text.includes('name="capt"') || text.includes('SignIn') || text.includes('Direct Access not allowed')) {
        if (retryCount >= this._maxRetries) {
          console.error(`[${this.name}] Session expired during SMS fetch. Max retries reached.`);
          return [];
        }
        console.log(`[${this.name}] Session expired during SMS fetch, re-logging in...`);
        this.isLoggedIn = false;
        await this.login(true);
        return this.getNewMessages(phoneNumber, retryCount + 1);
      }

      let json;
      try {
        json = typeof res.data === 'object' ? res.data : JSON.parse(text);
      } catch (e) {
        console.error(`[${this.name}] WhReports AJAX response not JSON: ${text.substring(0, 100)}`);
        return [];
      }

      const aaData = json.aaData || [];
      const messages = [];

      for (const row of aaData) {
        // WhReports columns: Date, Range, Number, CLI, Currency, Payterm, Payout, Message
        // (Last row is totals row with comma-separated values — skip it)
        if (!Array.isArray(row) || row.length < 8) continue;

        const rawDate = String(row[0] || '');
        if (rawDate.includes(',')) continue; // totals row

        const rangeName = String(row[1] || '');
        const numStr = String(row[2] || '').replace(/[\s\-\+]/g, '').trim();
        const cli = String(row[3] || '');   // SenderID / CLI
        const msgText = String(row[7] || ''); // Message body with OTP

        if (!numStr || numStr.length < 8) continue;

        const uniqueId = `${numStr}_${cli}_${rawDate}`;

        messages.push({
          id: uniqueId,
          app: cli || 'Unknown',
          message: msgText,
          time: rawDate,
          phoneNumber: numStr,
          panel: this.name
        });
      }

      console.log(`[${this.name}] WhReports: ${messages.length} messages`);

      if (phoneNumber !== 'all') {
        const normalizedTarget = phoneNumber.replace(/[\s\-\+]/g, '');
        return messages.filter(msg => {
          const normalizedMsgNum = msg.phoneNumber.replace(/[\s\-\+]/g, '');
          return normalizedMsgNum.includes(normalizedTarget) || normalizedTarget.includes(normalizedMsgNum);
        });
      }

      return messages;
    } catch (e) {
      console.error(`[${this.name}] getNewMessages error: ${e.message}`);
      return [];
    }
  }
}

module.exports = purplePanel;
