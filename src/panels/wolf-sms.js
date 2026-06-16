// ============================================================
// INTS PANEL SCRAPER (গণনীয় /ints/ login structure)
// FIXED v3: Dynamic panel name, retry limits, no infinite loops
// ============================================================

const BasePanel = require('./base');
const cheerio = require('cheerio');

class WolfSMSPanel extends BasePanel {
  constructor(config) {
    super(config);
    this._lastNumberCount = 0;
    this._maxRetries = 2; // সর্বোচ্চ 2 বার retry — infinite loop prevention
  }

  /**
   * উপলব্ধ নাম্বর লিস্ট আনা
   * প্রথমে AJAX endpoint চেষ্টা, ব্যর্থ হলে HTML page থেকে scrape
   */
  async getAvailableNumbers(appId) {
    // পদ্ধতি ১: AJAX endpoint (DataTable server-side)
    const ajaxNumbers = await this._getNumbersViaAjax(appId, 0);
    if (ajaxNumbers.length > 0) return ajaxNumbers;

    console.log(`[${this.name}] AJAX returned 0 numbers, trying HTML fallback...`);

    // পদ্ধতি ২: HTML page scraping (fallback)
    const htmlNumbers = await this._getNumbersViaHtml(appId);
    if (htmlNumbers.length > 0) return htmlNumbers;

    return [];
  }

  /**
   * AJAX endpoint থেকে নাম্বর আনা
   * Endpoint: res/data_smsnumbers.php
   */
  async _getNumbersViaAjax(appId, retryCount = 0) {
    const ajaxUrl = `${this._url(this.dashboardPath)}/res/data_smsnumbers.php?frange=&fclient=`;

    try {
      const response = await this.client.get(ajaxUrl, {
        maxRedirects: 5,
        headers: {
          ...this._headers(),
          'X-Requested-With': 'XMLHttpRequest',
          'Accept': 'application/json, text/javascript, */*; q=0.01'
        }
      });

      const text = typeof response.data === 'string' ? response.data : JSON.stringify(response.data);

      // লগইন পেজে গেলে রিলগইন (retry limit সহ)
      if (text.includes('type="password"')) {
        if (retryCount >= this._maxRetries) {
          console.error(`[${this.name}] Session expired, max retries (${this._maxRetries}) reached. Giving up.`);
          return [];
        }
        console.log(`[${this.name}] Session expired during number fetch, re-logging in (retry ${retryCount + 1}/${this._maxRetries})...`);
        this.isLoggedIn = false;
        await this.login(true);
        return this._getNumbersViaAjax(appId, retryCount + 1);
      }

      // JSON parse চেষ্টা
      let json;
      try {
        json = JSON.parse(text);
      } catch (parseErr) {
        console.log(`[${this.name}] AJAX response is not JSON (${text.substring(0, 100)}...)`);
        return [];
      }

      const numbers = [];

      if (json.aaData && Array.isArray(json.aaData)) {
        const totalRecords = json.iTotalDisplayRecords || json.aaData.length;
        console.log(`[${this.name}] AJAX: Total ${totalRecords} records from panel`);

        for (const row of json.aaData) {
          if (row.length >= 4) {
            // row[3] = Number column
            let number = row[3];
            const $ = cheerio.load(number);
            number = $.text().trim();

            if (number && number.length >= 8 && /\d{8,}/.test(number)) {
              let rangeName = row[1];
              const $r = cheerio.load(rangeName);
              rangeName = $r.text().trim();

              let payout = row[4] || '';
              if (payout) {
                const $p = cheerio.load(payout);
                payout = $p.text().trim();
              }

              numbers.push({
                number: number,
                range: rangeName,
                prefix: row[2] || '',
                panel: this.name,
                payout: payout,
                id: this._extractId(row[0])
              });
            }
          }
        }
      } else if (json.data && Array.isArray(json.data)) {
        // ভিন্ন response format
        console.log(`[${this.name}] AJAX: Found json.data array with ${json.data.length} items`);
        for (const row of json.data) {
          const number = String(row.number || row.num || row.phone || '').trim();
          if (number.length >= 8 && /\d{8,}/.test(number)) {
            numbers.push({
              number: number,
              range: row.range || '',
              prefix: row.prefix || '',
              panel: this.name,
              payout: row.payout || row.price || '',
              id: row.id || ''
            });
          }
        }
      } else {
        console.log(`[${this.name}] AJAX: Unexpected JSON structure: ${Object.keys(json).join(', ')}`);
      }

      this._lastNumberCount = numbers.length;
      console.log(`[${this.name}] Parsed ${numbers.length} valid numbers`);
      return numbers;

    } catch (error) {
      console.error(`[${this.name}] AJAX error: ${error.message}`);
      return [];
    }
  }

  /**
   * HTML page থেকে নাম্বার আনা (fallback)
   * MySMSNumbers page থেকে table scrape
   */
  async _getNumbersViaHtml(appId) {
    try {
      const result = await this.fetchPage('MySMSNumbers');
      if (!result || !result.html) return [];

      const $ = cheerio.load(result.html);
      const numbers = [];

      // DataTable structure: table with <tbody> rows
      $('table tbody tr').each((index, element) => {
        const $row = $(element);
        const cells = $row.find('td');

        // সারির প্রতিটি cell চেক করে ফোন নাম্বার খোঁজা
        let foundNumber = null;
        let rangeName = '';
        let prefix = '';
        let payout = '';

        if (cells.length >= 3) {
          cells.each((colIndex, cell) => {
            const cellText = $(cell).text().trim();
            const cleanCell = cellText.replace(/[\s\-<>]/g, '');

            // ফোন নাম্বার detect (8+ digits, no letters)
            if (/\d{8,15}/.test(cleanCell) && !foundNumber) {
              const numMatch = cleanCell.match(/\d{8,15}/);
              if (numMatch) {
                foundNumber = numMatch[0];
              }
            }

            // Range name detect (contains country/operator names)
            if (colIndex <= 2 && cellText.length > 5 && /[A-Za-z]/.test(cellText) && !rangeName) {
              rangeName = cellText;
            }

            // Payout detect (contains $ or € or any currency symbol)
            if (cellText.includes('$') || cellText.includes('€') || cellText.includes('£')) {
              payout = cellText;
            }
          });

          if (foundNumber) {
            numbers.push({
              number: foundNumber,
              range: rangeName,
              prefix: prefix,
              panel: this.name,
              payout: payout,
              id: ''
            });
          }
        }
      });

      // সাধারণ পার্সিং ফলব্যাক - body text থেকে ফোন নাম্বার extract
      if (numbers.length === 0) {
        const bodyText = $('body').text();
        const phoneRegex = /(?<!\d)(\d{8,15})(?!\d)/g;
        let match;
        const seen = new Set();
        while ((match = phoneRegex.exec(bodyText)) !== null) {
          const num = match[1];
          if (!seen.has(num) && !num.startsWith('00') && num.length >= 8) {
            seen.add(num);
            numbers.push({
              number: num,
              range: '',
              prefix: '',
              panel: this.name,
              id: ''
            });
          }
        }
      }

      console.log(`[${this.name}] HTML fallback: Found ${numbers.length} numbers`);
      return numbers;

    } catch (error) {
      console.error(`[${this.name}] HTML fallback error: ${error.message}`);
      return [];
    }
  }

  /**
   * নতুন SMS / OTP চেক
   * প্রথমে AJAX, ব্যর্থ হলে HTML fallback
   */
  async getNewMessages(phoneNumber) {
    const ajaxMessages = await this._getMessagesViaAjax(phoneNumber, 0);
    if (ajaxMessages.length > 0) return ajaxMessages;

    // HTML fallback
    const htmlMessages = await this._getMessagesViaHtml(phoneNumber);
    if (htmlMessages.length > 0) return htmlMessages;

    return [];
  }

  /**
   * SMSCDRReports পেজ থেকে sesskey সহ AJAX URL বের করা
   */
  async _getAjaxUrlWithSesskey() {
    try {
      const cdrUrl = `${this._url(this.dashboardPath)}/SMSCDRReports`;
      const res = await this.client.get(cdrUrl, {
        maxRedirects: 5,
        headers: this._headers()
      });
      const html = typeof res.data === 'string' ? res.data : '';
      // sAjaxSource": "res/data_smscdr.php?...&sesskey=XXXXX"
      const match = html.match(/sAjaxSource["']?\s*:\s*["'](res\/data_smscdr\.php[^"']+)["']/);
      if (match) {
        const relativeUrl = match[1];
        return `${this._url(this.dashboardPath)}/${relativeUrl}`;
      }
      return null;
    } catch (e) {
      return null;
    }
  }

  /**
   * AJAX endpoint থেকে SMS আনা
   */
  async _getMessagesViaAjax(phoneNumber, retryCount = 0) {
    const today = new Date().toISOString().split('T')[0];

    // প্রথমে sesskey সহ AJAX URL বের করার চেষ্টা
    let ajaxUrl = await this._getAjaxUrlWithSesskey();

    // sesskey পাওয়া না গেলে fallback URL ব্যবহার করো
    if (!ajaxUrl) {
      ajaxUrl = `${this._url(this.dashboardPath)}/res/data_smscdr.php?fdate1=${today}+00%3A00%3A00&fdate2=${today}+23%3A59%3A59&frange=&fclient=&fnum=&fcli=&fgdate=&fgmonth=&fgrange=&fgclient=&fgnumber=&fgcli=&fg=0`;
    }

    try {
      const response = await this.client.get(ajaxUrl, {
        maxRedirects: 5,
        headers: {
          ...this._headers(),
          'X-Requested-With': 'XMLHttpRequest',
          'Accept': 'application/json, text/javascript, */*; q=0.01'
        }
      });

      const text = typeof response.data === 'string' ? response.data : JSON.stringify(response.data);

      if (text.includes('type="password"')) {
        if (retryCount >= this._maxRetries) {
          console.error(`[${this.name}] SMS fetch: max retries (${this._maxRetries}) reached. Giving up.`);
          return [];
        }
        this.isLoggedIn = false;
        await this.login(true);
        return this._getMessagesViaAjax(phoneNumber, retryCount + 1);
      }

      let json;
      try {
        json = JSON.parse(text);
      } catch (parseErr) {
        return [];
      }

      const messages = [];

      if (json.aaData && Array.isArray(json.aaData)) {
        const cleanPhone = phoneNumber.replace(/[\s\-\+]/g, '');

        for (const row of json.aaData) {
          if (row.length < 6) continue;

          const number = String(row[2] || '').replace(/[\s\-\+]/g, '');
          const cli = String(row[3] || '');
          const smsText = String(row[5] || '');
          const date = String(row[0] || '');

          if (phoneNumber === 'all' || number.includes(cleanPhone) || String(row[2] || '').includes(phoneNumber)) {
            messages.push({
              sender: cli || 'Unknown',
              message: smsText,
              time: date,
              phoneNumber: String(row[2] || phoneNumber),
              panel: this.name,
              range: String(row[1] || ''),
              payout: String(row[7] || '')
            });
          }
        }
      }

      console.log(`[${this.name}] AJAX: ${messages.length} messages for ${phoneNumber}`);
      return messages;

    } catch (error) {
      console.error(`[${this.name}] SMS AJAX error: ${error.message}`);
      return [];
    }
  }

  /**
   * HTML page থেকে SMS আনা (fallback)
   */
  async _getMessagesViaHtml(phoneNumber) {
    try {
      const result = await this.fetchPage('SMSCDRReports');
      if (!result || !result.html) return [];

      const $ = cheerio.load(result.html);
      const messages = [];
      const cleanPhone = phoneNumber.replace(/[\s\-\+]/g, '');

      $('table tbody tr').each((i, el) => {
        const $row = $(el);
        const rowText = $row.text();

        if (phoneNumber === 'all' || rowText.includes(phoneNumber) || rowText.includes(cleanPhone)) {
          const cells = $row.find('td');
          const date = cells.length > 0 ? $(cells[0]).text().trim() : '';
          const number = cells.length > 2 ? $(cells[2]).text().trim() : '';
          const sender = cells.length > 3 ? $(cells[3]).text().trim() : 'Unknown';

          // SMS text - সাধারণত শেষের কাছাকাছি column-এ থাকে
          let smsText = '';
          for (let c = 4; c < cells.length; c++) {
            const t = $(cells[c]).text().trim();
            if (t.length > 10) { // SMS text সাধারণত 10+ chars
              smsText = t;
            }
          }

          if (smsText && smsText.length > 3) {
            messages.push({
              sender: sender,
              message: smsText,
              time: date,
              phoneNumber: number || phoneNumber,
              panel: this.name
            });
          }
        }
      });

      console.log(`[${this.name}] HTML fallback: ${messages.length} messages`);
      return messages;

    } catch (error) {
      console.error(`[${this.name}] SMS HTML error: ${error.message}`);
      return [];
    }
  }

  /**
   * সব উপলব্ধ range এর নাম ও নাম্বর count আনা (admin /ranges এর জন্য)
   * Returns: [{ range: 'Russia 7', count: 150 }, ...]
   */
  async getAllRanges(retryCount = 0) {
    const ajaxUrl = `${this._url(this.dashboardPath)}/res/data_smsnumbers.php?frange=&fclient=`;

    try {
      const response = await this.client.get(ajaxUrl, {
        maxRedirects: 5,
        headers: {
          ...this._headers(),
          'X-Requested-With': 'XMLHttpRequest',
          'Accept': 'application/json, text/javascript, */*; q=0.01'
        }
      });

      const text = typeof response.data === 'string' ? response.data : JSON.stringify(response.data);

      if (text.includes('type="password"')) {
        if (retryCount >= this._maxRetries) {
          console.error(`[${this.name}] getAllRanges: max retries reached. Giving up.`);
          return [];
        }
        this.isLoggedIn = false;
        await this.login(true);
        return this.getAllRanges(retryCount + 1);
      }

      let json;
      try {
        json = JSON.parse(text);
      } catch (parseErr) {
        return [];
      }

      if (json.aaData && Array.isArray(json.aaData)) {
        // range name ও count বের করা
        const rangeMap = {};
        for (const row of json.aaData) {
          if (row.length >= 4) {
            let number = row[3];
            const $ = cheerio.load(number);
            number = $.text().trim();
            if (number && /\d{8,}/.test(number)) {
              let rangeName = row[1];
              const $r = cheerio.load(rangeName);
              rangeName = $r.text().trim();
              if (rangeName) {
                rangeMap[rangeName] = (rangeMap[rangeName] || 0) + 1;
              }
            }
          }
        }

        // Sort by count (descending)
        const ranges = Object.entries(rangeMap)
          .map(([range, count]) => ({ range, count }))
          .sort((a, b) => b.count - a.count);

        console.log(`[${this.name}] Found ${ranges.length} unique ranges`);
        return ranges;
      }

      return [];
    } catch (error) {
      console.error(`[${this.name}] getAllRanges error: ${error.message}`);
      return [];
    }
  }

  /**
   * Checkbox HTML থেকে ID extract
   */
  _extractId(html) {
    if (!html) return '';
    const match = html.match(/value=['"](\d+)['"]/);
    return match ? match[1] : '';
  }
}

module.exports = WolfSMSPanel;
