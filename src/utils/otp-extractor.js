// ============================================================
// OTP এক্সট্র্যাক্টর - SMS থেকে OTP কোড বের করা
// Supports: English, French, Arabic, generic numeric patterns
// ============================================================

function extractOTP(message) {
  if (!message) return null;
  const text = message.trim();

  const otpPatterns = [
    // English patterns
    /(?:code|kod|pin| otp|one.?time.?pass)[\s:]*([0-9]{4,8})/i,
    /(?:verification|verify|auth|token|key)[\s:]*([0-9]{4,8})/i,
    /([0-9]{4,8})\s+is\s+(?:your|the| verification)/i,
    /use\s+([0-9]{4,8})/i,

    // French patterns (প্যানেলে প্রচুর French SMS আসে)
    /(?:code|le code)\s+(?:de\s+)?(?:v[ée]rification|r[ée]initialisation|s[ée]curit[ée]|confirmation|connexion)[\s:]+([0-9]{4,8})/i,
    /(?:votre|your)\s+(?:code|mot de passe)[\s:]+(?:est\s+)?([0-9]{4,8})/i,
    /([0-9]{4,8})\s+est\s+(?:le\s+)?(?:code|votre|your)/i,
    /v[ée]rification[\s:]+([0-9]{4,8})/i,

    // Generic patterns
    /[\[#\[]([0-9]{4,8})[\]\]#\]]/,
    /(?:is|হলো|হল|:)\s*([0-9]{4,8})\s*(?:\.|,|\s|$)/i,
    /(?:^|\s)([0-9]{4,8})(?:\s|$)/
  ];

  for (const pattern of otpPatterns) {
    const match = text.match(pattern);
    if (match && match[1]) {
      const code = match[1];
      if (code.length >= 4 && code.length <= 8) {
        return code;
      }
    }
  }

  return null;
}

function extractSender(message) {
  if (!message) return 'Unknown';
  const lines = message.split('\n').filter(l => l.trim());
  return lines[0] ? lines[0].substring(0, 50) : 'Unknown';
}

/**
 * SMS মেসেজের কন্টেন্ট দেখে অ্যাপ আইডি ডিটেক্ট করা
 */
function extractApp(message) {
  if (!message) return null;
  const text = message.toLowerCase();

  // Facebook
  if (
    text.includes('facebook') ||
    text.includes('fb') && text.includes('code') ||
    text.includes('facebook.com')
  ) return 'facebook';

  // WhatsApp
  if (
    text.includes('whatsapp') ||
    text.includes('wa.me')
  ) return 'whatsapp';

  // Instagram
  if (
    text.includes('instagram') ||
    text.includes('ig ') ||
    text.includes('instagram.com')
  ) return 'instagram';

  // TikTok
  if (
    text.includes('tiktok') ||
    text.includes('tik tok')
  ) return 'tiktok';

  // Telegram
  if (
    text.includes('telegram') ||
    text.includes('t.me')
  ) return 'telegram';

  // Twitter / X
  if (
    text.includes('twitter') ||
    text.includes(' x.com')
  ) return 'twitter';

  return null;
}

module.exports = { extractOTP, extractSender, extractApp };
