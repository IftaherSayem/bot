// ============================================================
// INS PANEL API CLIENT
// v1: Direct API communication, JSON endpoints, no HTML scraping
// ============================================================

const BasePanel = require('./base');

class insPanel extends BasePanel {
  constructor(config) {
    super(config);
    this.email = config.email || config.username;
    this.accessToken = null;
    this.agentId = null;
    this.refreshToken = null;
  }

  /**
   * REST API Login override
   */
  async login(force = false) {
    if (this.isLoggedIn && this.accessToken && !force) return true;

    try {
      console.log(`[${this.name}] Authenticating via REST API...`);
      const response = await this.client.post(this._url('/api/auth/login'), {
        email: this.email,
        password: this.password
      }, {
        headers: {
          'Content-Type': 'application/json'
        }
      });

      if (response.status !== 200 || !response.data || response.data.error) {
        const errorMsg = response.data?.error?.message || 'Invalid credentials or API error';
        console.error(`[${this.name}] REST Login FAILED: ${errorMsg}`);
        this.loginFailures++;
        this.isLoggedIn = false;
        return false;
      }

      const session = response.data?.data?.session;
      const user = response.data?.data?.user;

      if (!session || !session.access_token) {
        console.error(`[${this.name}] REST Login FAILED: Session data not found in response`);
        this.loginFailures++;
        this.isLoggedIn = false;
        return false;
      }

      this.accessToken = session.access_token;
      this.refreshToken = session.refresh_token;
      this.agentId = user?.id || null;
      this.isLoggedIn = true;
      this.loginFailures = 0;
      this.lastLoginAttempt = new Date();
      console.log(`[${this.name}] REST Login SUCCESS (Agent ID: ${this.agentId})`);
      return true;
    } catch (e) {
      console.error(`[${this.name}] REST Login ERROR: ${e.message}`);
      this.loginFailures++;
      this.isLoggedIn = false;
      return false;
    }
  }

  /**
   * Helper to make POST request to RPC functions
   */
  async _rpc(rpcName, payload = {}) {
    if (!this.isLoggedIn) {
      const ok = await this.login();
      if (!ok) throw new Error('Not authenticated');
    }

    const url = this._url(`/api/rpc/${rpcName}`);
    try {
      const response = await this.client.post(url, payload, {
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.accessToken}`
        }
      });

      // Token invalid/expired check (401 status)
      if (response.status === 401) {
        console.log(`[${this.name}] Bearer token expired. Re-authenticating...`);
        this.isLoggedIn = false;
        const loggedIn = await this.login(true);
        if (!loggedIn) throw new Error('Re-authentication failed');
        
        // Retry request
        return await this._rpc(rpcName, payload);
      }

      return response.data || {};
    } catch (e) {
      console.error(`[${this.name}] RPC [${rpcName}] error: ${e.message}`);
      throw e;
    }
  }

  /**
   * available number list fetch
   */
  async getAvailableNumbers(appId) {
    if (!this.isLoggedIn) {
      const ok = await this.login();
      if (!ok) return [];
    }

    try {
      const rpcResult = await this._rpc('get_agent_all_numbers', { _agent_id: this.agentId });
      const data = Array.isArray(rpcResult) ? rpcResult : (rpcResult.data || []);

      // Format to match wolf-sms number structures:
      // { number, range, prefix, panel, payout, id }
      const numbers = data
        .filter(row => row.status === 'available' || row.status === 'assigned')
        .map(row => {
          const numStr = String(row.number || '').trim();
          return {
            number: numStr,
            range: row.cli_name || 'Unknown',
            prefix: '',
            panel: this.name,
            payout: String(row.agent_price || row.agent_payout || '0'),
            id: String(row.id || '')
          };
        });

      return numbers;
    } catch (e) {
      console.error(`[${this.name}] getAvailableNumbers error: ${e.message}`);
      return [];
    }
  }

  /**
   * ranges list fetch
   */
  async getAllRanges() {
    if (!this.isLoggedIn) {
      const ok = await this.login();
      if (!ok) return [];
    }

    try {
      const rpcResult = await this._rpc('get_agent_all_numbers', { _agent_id: this.agentId });
      const data = Array.isArray(rpcResult) ? rpcResult : (rpcResult.data || []);
      
      const rangeMap = {};
      data.forEach(row => {
        if (row.status === 'available' || row.status === 'assigned') {
          const rName = row.cli_name || 'Unknown';
          rangeMap[rName] = (rangeMap[rName] || 0) + 1;
        }
      });

      return Object.entries(rangeMap).map(([range, count]) => ({
        range,
        count
      }));
    } catch (e) {
      console.error(`[${this.name}] getAllRanges error: ${e.message}`);
      return [];
    }
  }

  /**
   * new message list fetch
   */
  async getNewMessages(phoneNumber = 'all') {
    if (!this.isLoggedIn) {
      const ok = await this.login();
      if (!ok) return [];
    }

    try {
      const rpcResult = await this._rpc('get_agent_client_sms', {
        _agent_id: this.agentId,
        _limit: 1000
      });
      const data = Array.isArray(rpcResult) ? rpcResult : (rpcResult.data || []);

      // Format to match OTP log structures:
      // { id, app, message, time, phoneNumber, panel }
      const messages = data.map(row => {
        return {
          id: String(row.id || ''),
          app: String(row.platform || 'Unknown'),
          message: String(row.message_text || row.otp_code || ''),
          time: row.received_at,
          phoneNumber: String(row.number || ''),
          panel: this.name
        };
      });

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

module.exports = insPanel;
