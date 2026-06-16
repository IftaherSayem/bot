// ============================================================
// নাম্বর ম্যানেজার - নাম্বর অ্যালোকেশন ও ট্র্যাকিং
// v8.2: নাম্বার আর auto-expire হবে না
//       ইউজার নতুন নাম্বার রিকোয়েস্ট করলে আগেরটি release হবে
//       অথবা /cancel দিলে সব release হবে
// ============================================================

const db = require('../../database');
const config = require('../../config');

class NumberManager {

  /**
   * ইউজারকে নাম্বর অ্যালোকেট করা
   * আগের অ্যাক্টিভ নাম্বারগুলো auto-release হবে
   * @param {number} telegramUserId
   * @param {string} appId
   * @param {Array} availableNumbers - প্যানেল থেকে পাওয়া নাম্বার
   * @returns {Array} অ্যালোকেট করা নাম্বার লিস্ট
   */
  allocateNumbers(telegramUserId, appId, availableNumbers, botToken = null) {
    const count = Math.min(config.NUMBERS_PER_REQUEST, availableNumbers.length);

    if (count === 0) {
      return [];
    }

    // প্রথমে এই ইউজারের আগের সব অ্যাক্টিভ নাম্বার release করুন
    this.releaseUserNumbers(telegramUserId);

    // অন্য ইউজারদের অ্যালোকেট করা নাম্বার বাদ দেওয়া
    const currentlyAllocated = this._getCurrentlyAllocatedNumbers();
    const available = availableNumbers.filter(num => {
      const normalized = num.number.replace(/[\s\-\+]/g, '');
      return !currentlyAllocated.has(normalized);
    });

    const toAllocate = available.slice(0, config.NUMBERS_PER_REQUEST);

    if (toAllocate.length === 0) {
      return [];
    }

    // ডেটাবেসে রেকর্ড করা (payout সহ, no expires_at)
    const stmt = db.prepare(`
      INSERT INTO number_allocations (telegram_user_id, phone_number, panel_name, app_id, status, payout, bot_token)
      VALUES (?, ?, ?, ?, 'active', ?, ?)
    `);

    const transaction = db.transaction((numbers) => {
      for (const num of numbers) {
        const payout = num.payout || '';
        stmt.run(telegramUserId, num.number, num.panel, appId, payout, botToken);
      }
    });

    transaction(toAllocate);

    // ইউজার সেশন আপডেট
    this._updateUserSession(telegramUserId, appId, toAllocate);

    console.log(`Allocated ${toAllocate.length} numbers to user ${telegramUserId} for app ${appId}`);
    return toAllocate;
  }

  /**
   * ইউজারের বর্তমান অ্যাক্টিভ নাম্বার পাওয়া
   * (no expire check — নাম্বার সবসময় অ্যাক্টিভ থাকবে যতক্ষণ না release হচ্ছে)
   */
  getUserActiveNumbers(telegramUserId) {
    const rows = db.prepare(`
      SELECT * FROM number_allocations
      WHERE telegram_user_id = ? AND status = 'active'
      ORDER BY allocated_at DESC
    `).all(telegramUserId);

    return rows;
  }

  /**
   * নির্দিষ্ট নাম্বারে OTP সেভ করা
   */
  saveOTP(phoneNumber, otpCode, fullMessage, panelName, appId, telegramUserId) {
    db.prepare(`
      UPDATE number_allocations
      SET otp_code = ?, otp_received_at = datetime('now'), status = 'completed'
      WHERE phone_number = ? AND telegram_user_id = ? AND status = 'active'
    `).run(otpCode, phoneNumber, telegramUserId);

    // OTP লগেও সেভ
    db.prepare(`
      INSERT INTO otp_logs (phone_number, panel_name, app_id, otp_code, full_message, telegram_user_id, sent_to_user)
      VALUES (?, ?, ?, ?, ?, ?, 1)
    `).run(phoneNumber, panelName, appId, otpCode, fullMessage, telegramUserId);
  }

  /**
   * অন্য ইউজারদের দ্বারা ইতিমধ্যে ব্যবহৃত নাম্বার লিস্ট পাওয়া
   * (no expire check)
   */
  _getCurrentlyAllocatedNumbers() {
    const rows = db.prepare(`
      SELECT phone_number FROM number_allocations
      WHERE status = 'active'
    `).all();

    const set = new Set();
    for (const row of rows) {
      set.add(row.phone_number.replace(/[\s\-\+]/g, ''));
    }
    return set;
  }

  /**
   * ইউজার সেশন আপডেট
   */
  _updateUserSession(telegramUserId, appId, numbers) {
    const numberList = JSON.stringify(numbers.map(n => n.number));

    db.prepare(`
      INSERT INTO user_sessions (telegram_user_id, state, selected_app, assigned_numbers, updated_at)
      VALUES (?, 'waiting_otp', ?, ?, datetime('now'))
      ON CONFLICT(telegram_user_id) DO UPDATE SET
        state = 'waiting_otp',
        selected_app = excluded.selected_app,
        assigned_numbers = excluded.assigned_numbers,
        updated_at = datetime('now')
    `).run(telegramUserId, appId, numberList);
  }

  /**
   * ইউজারের OTP সেশন রিলিজ (সম্পন্ন / বাতিল)
   * সব অ্যাক্টিভ নাম্বার release হবে
   */
  releaseUserNumbers(telegramUserId) {
    const result = db.prepare(`
      UPDATE number_allocations SET status = 'released'
      WHERE telegram_user_id = ? AND status = 'active'
    `).run(telegramUserId);

    if (result.changes > 0) {
      console.log(`Released ${result.changes} numbers for user ${telegramUserId}`);
    }

    db.prepare(`
      UPDATE user_sessions SET state = 'idle', updated_at = datetime('now')
      WHERE telegram_user_id = ?
    `).run(telegramUserId);
  }

  /**
   * একটি মাত্র নাম্বার release করা (অন্য নাম্বার অক্ষত থাকবে)
   */
  releaseSingleNumber(telegramUserId, phoneNumber) {
    db.prepare(`
      UPDATE number_allocations SET status = 'released'
      WHERE telegram_user_id = ? AND phone_number = ? AND status = 'active'
    `).run(telegramUserId, phoneNumber);

    // চেক করা হবে এই user এর আরো active number আছে কিনা
    // (no expire check)
    const remaining = db.prepare(`
      SELECT COUNT(*) as cnt FROM number_allocations
      WHERE telegram_user_id = ? AND status = 'active'
    `).get(telegramUserId);

    if (remaining.cnt === 0) {
      db.prepare(`
        UPDATE user_sessions SET state = 'idle', updated_at = datetime('now')
        WHERE telegram_user_id = ?
      `).run(telegramUserId);
    }
  }
}

module.exports = new NumberManager();
