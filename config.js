// ============================================================
// CONFIGURATION - এই ফাইলে আপনার সেটিংস দিন (v2)
// ============================================================

module.exports = {
  // ---- মাল্টি-বট স্কেলিং (Horizontal Scaling) ----
  // এখানে একাধিক বটের টোকেন দিন। সবগুলো বট একসাথে চলবে।
  // name দেওয়া বাধ্যতামূলক নয়, শুধু টার্মিনালে চেনার সুবিধার জন্য দেওয়া হয়েছে।
  BOTS: [
    { token: '8809830622:AAGHTggQM6-IgLa-v0dfVcFqyrVkktRX3eI', name: 'MSH OTP Bot 1' },
    { token: '8145597441:AAGatlmdyU_1i5pRW_kkWlGd0Eqcpwfpyy8', name: 'MSH OTP Bot 2' },
    { token: '8712159289:AAE-v9NCPY4dit7F0A0AWVoh_O-Wcb_00cU', name: 'MSH OTP Bot 3' },
    { token: '8922077637:AAGjWsJlizhVB_wX7OJRAAIoaKiwly5Ih5o', name: 'MSH OTP Bot 4' },
    { token: '8947932760:AAF8xWUy_5tq51YEu839jShyz_UwPufaJts', name: 'MSH OTP Bot 5' },
    { token: '8659717730:AAGbdGWsJ-zEMZifSlZAp8Pm8k9WNddXfN8', name: 'MSH OTP Bot 6' },
    { token: '8865596971:AAHgA0mPVrrtywOvmqJtiPAKtHMG7svRo4o', name: 'MSH OTP Bot 7' },
    { token: '8626900886:AAECnm5UxwNmtbULK6zrg2wAMCVdTX2orIE', name: 'MSH OTP Bot 8' },
    // { token: 'YOUR_SECOND_BOT_TOKEN', name: 'MSH OTP Bot 2' },
  ],

  // ---- অ্যাডমিন ইউজার ID ----
  // একাধিক অ্যাডমিন রাখতে কমা দিয়ে ID গুলো দিন (যেমন: [6623300482, 123456789])
  ADMIN_USER_IDS: [6623300482, 7329874221],
  ALLOWED_USERS: [],

  // ---- OTP পোলিং সেটিংস ----
  OTP_POLL_INTERVAL: parseInt(process.env.OTP_POLL_INTERVAL) || 10,

  // ---- OTP গ্রুপ সেটিংস ----
  // সব live OTP এই গ্রুপেও পাঠানো হবে
  OTP_GROUP_ID: -1002694444904,
  // OTP বাটনে ক্লিক করলে এই লিংকে নিয়ে যাবে
  OTP_GROUP_LINK: 'https://t.me/mshotp',
  // Main Channel Link (for the second button)
  MAIN_CHANNEL_LINK: 'https://t.me/your_main_channel',

  // ---- NUMBERS_PER_REQUEST ----
  // প্রতি রিকোয়েস্টে কয়টি নাম্বার দেবে
  NUMBERS_PER_REQUEST: 2,

  // ---- PROXY সেটিংস ----
  // যদি Telegram API-তে কানেক্ট করা না যায়:
  //   PROXY_URL: 'socks5://user:pass@host:port'
  //   PROXY_URL: 'http://user:pass@host:port'
  //   PROXY_URL: 'http://host:port'
  PROXY_URL: process.env.PROXY_URL || '',

  // ---- সেশন টাইমআউট ----
  SESSION_TIMEOUT: 600,

  // ---- OTP এক্সপায়ার ----
  // নাম্বার আর auto-expire হবে না — ইউজার নতুন নাম্বার রিকোয়েস্ট করলে আগেরটি release হবে
  // এই ভ্যালু শুধু ডেটাবেসের backward compatibility এর জন্য আছে
  NUMBER_EXPIRE_MINUTES: 99999,

  // ---- SMS প্যানেল কনফিগারেশন ----
  PANELS: [
    // ---- Panel 1: Wolf SMS (213.32.24.208) ✅ ----
    {
      name: 'Wolf SMS',
      baseUrl: 'http://213.32.24.208',
      loginPageUrl: '/ints/login',
      signinUrl: '/ints/signin',
      dashboardPath: '/ints/agent',
      username: 'tahsan100',
      password: 'tahsan100',
      enabled: true
    },
    // ---- Panel 2: KM SMS (54.36.173.235) ✅ ----
    {
      name: 'KM SMS',
      baseUrl: 'http://54.36.173.235',
      loginPageUrl: '/ints/login',
      signinUrl: '/ints/signin',
      dashboardPath: '/ints/agent',
      username: 'tahsan100',
      password: 'tahsan200',
      enabled: true
    },
    // ---- Panel 3: Flex SMS (168.119.13.175) ✅ ----
    {
      name: 'Flex SMS',
      baseUrl: 'http://168.119.13.175',
      loginPageUrl: '/ints/login',
      signinUrl: '/ints/signin',
      dashboardPath: '/ints/agent',
      username: 'tahsan100',
      password: 'tahsan100',
      enabled: true
    },
    // ---- Panel 4: Zento SMS (54.38.176.48) ✅ ----
    {
      name: 'Zento SMS',
      baseUrl: 'http://54.38.176.48',
      loginPageUrl: '/ints/login',
      signinUrl: '/ints/signin',
      dashboardPath: '/ints/agent',
      username: 'tahsan100',
      password: 'tahsan100',
      enabled: true
    },
    // ---- Panel 5: SMS Hadi (smshadi.net) ✅ ----
    {
      name: 'SMS Hadi',
      baseUrl: 'http://smshadi.net',
      loginPageUrl: '/login',
      signinUrl: '/signin',
      dashboardPath: '/agent',
      username: 'tahsan100',
      password: 'tahsan200',
      enabled: true
    },
    // ---- Panel 6: SHARK SMS (65.109.111.158) ✅ ----
    {
      name: 'SHARK SMS',
      baseUrl: 'http://65.109.111.158',
      loginPageUrl: '/ints/login',
      signinUrl: '/ints/signin',
      dashboardPath: '/ints/agent',
      username: 'tahsan100',
      password: 'tahsan200',
      enabled: true
    },
    // ---- Panel 7: MSI SMS (145.239.130.45) ✅ ----
    {
      name: 'MSI SMS',
      baseUrl: 'http://145.239.130.45',
      loginPageUrl: '/ints/login',
      signinUrl: '/ints/signin',
      dashboardPath: '/ints/agent',
      username: 'tashsan100',
      password: 'tahsan200',
      enabled: true
    },
    // ---- Panel 8: LAMIX SMS (145.239.130.45) ✅ ----
    {
      name: 'LAMIX SMS',
      baseUrl: 'http://51.210.208.26',
      loginPageUrl: '/ints/login',
      signinUrl: '/ints/signin',
      dashboardPath: '/ints/agent',
      username: 'tahsan100',
      password: 'tahsan1000',
      enabled: true
    },
    // ---- Panel 9: INS SMS (203.161.58.20) ✅ ----
    {
      name: 'INS SMS',
      type: 'ins',
      baseUrl: 'http://203.161.58.20',
      loginPageUrl: '/api/auth/login',
      signinUrl: '/api/auth/login',
      dashboardPath: '',
      username: 'tahsanislammahin@gmail.com',
      password: 'tahsan200',
      enabled: true // Change to true and enter correct email/password to enable
    },
    // ---- Panel 10: Purple SMS (85.195.94.50) ✅ ----
    {
      name: 'Purple SMS',
      type: 'purple',
      baseUrl: 'http://85.195.94.50',
      loginPageUrl: '/sms/SignIn',
      signinUrl: '/sms/signmein',
      dashboardPath: '/sms/reseller/MyNotifications',
      username: 'tahsan',
      password: 'tahsan',
      enabled: true
    },
    // ---- Panel 11: EVS SMS (57.129.107.62) ✅ ----
    {
      name: 'EVS SMS',
      type: 'evs',
      baseUrl: 'http://57.129.107.62',
      loginPageUrl: '/ints/login',
      signinUrl: '/ints/signin',
      dashboardPath: '/ints/agent',
      username: 'tahsan100',
      password: 'tahsan100',
      enabled: true
    },
    // ---- Panel 12: CORE SMS (139.99.68.231) ✅ ----
    {
      name: 'CORE SMS',
      type: 'core',
      baseUrl: 'http://139.99.68.231',
      loginPageUrl: '/ints/login',
      signinUrl: '/ints/signin',
      dashboardPath: '/ints/agent',
      username: 'tahsan100',
      password: 'tahsan100',
      enabled: true
    },
    // ---- Panel 13: GREEN SMS (139.99.9.4) ✅ ----
    {
      name: 'GREEN SMS',
      type: 'green',
      baseUrl: 'http://139.99.9.4',
      loginPageUrl: '/ints/login',
      signinUrl: '/ints/signin',
      dashboardPath: '/ints/agent',
      username: 'tahsan100',
      password: 'tahsan100',
      enabled: true
    },


  ],

  // ---- সাপোর্টেড অ্যাপস / সার্ভিসেস ----
  // price সরাসরি panel থেকে আসবে
  SUPPORTED_APPS: [
    { id: 'whatsapp', name: 'WhatsApp', emoji: '' },
    { id: 'facebook', name: 'Facebook', emoji: '' },
    { id: 'tiktok', name: 'TikTok', emoji: '' },
    { id: 'instagram', name: 'Instagram', emoji: '' },
    { id: 'telegram', name: 'Telegram', emoji: '' },
  ],

  // ============================================================
  // অ্যাপ-এ-প্যানেল-রেঞ্জ ম্যাপিং (ম্যানুয়ালি সেট করুন)
  // ============================================================
  // ফরম্যাট: app_id: [{ panel: 'প্যানেলের নাম', range: 'রেঞ্জের নাম' }, ...]
  //
  // range এর নাম PARTIAL MATCH করবে (case-insensitive)
  // যেমন: range: 'Russia' ম্যাচ করবে "Russia 7", "Russia 8" ইত্যাদি
  //
  // range নাম জানতে হলে বটে /ranges কমান্ড দিন (admin only)
  //
  // ⚠️ যেসব app এর জন্য mapping নেই, সেগুলোতে নম্বর আসবে না!
  // ============================================================
  APP_NUMBER_MAPPING: {
    // ---- WhatsApp ----
    whatsapp: [
      // { panel: 'Wolf SMS', range: 'Russia' },
      // { panel: 'SMS Hub', range: 'India' },
    ],
    // ---- Facebook ----
    facebook: [
      // { panel: 'SMS Zone', range: 'Bangladesh' },
      // { panel: 'SMS Pro', range: 'Russia' },
    ],
    // ---- TikTok ----
    tiktok: [
      // { panel: 'Wolf SMS', range: 'Philippines' },
    ],
    // ---- Instagram ----
    instagram: [
      // { panel: 'SMS Hub', range: 'Brazil' },
    ],
    // ---- Telegram ----
    telegram: [
      // { panel: 'SMS Zone', range: 'Russia' },
    ],
  },

  // ---- টাইমজোন সেটিংস ----
  // বাংলাদেশ টাইমজোনের জন্য +6 দিন (সার্ভার UTC হলেও রিপোর্ট বাংলাদেশ টাইম অনুযায়ী দেখাবে)
  TIMEZONE_OFFSET: 6,

  // ---- ডেটাবেস ----
  DB_PATH: process.env.DB_PATH || './data/otp_bot.db'
};
