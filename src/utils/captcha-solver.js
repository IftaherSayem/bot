// ============================================================
// ক্যাপচা সলভার - Math CAPTCHA Solve
// ============================================================

/**
 * লগইন পেজ থেকে ক্যাপচা প্রশ্ন বের করে উত্তর দেয়
 * CAPTCHA ফরম্যাট: "What is X+Y=?" বা "What is X-Y=?"
 */
function solveMathCaptcha(html) {
  // বিভিন্ন ফরম্যাট সাপোর্ট
  const patterns = [
    /What\s+is\s+(\d+)\s*([+\-×*x÷/])\s*(\d+)\s*\??/i,
    /(\d+)\s*([+\-×*x÷/])\s*(\d+)\s*=/,
    /Solve\s*:\s*(\d+)\s*([+\-×*x÷/])\s*(\d+)/i,
    /(\d+)\s*([+\-×*x÷/])\s*(\d+)/
  ];

  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match) {
      const a = parseInt(match[1]);
      const operator = match[2];
      const b = parseInt(match[3]);

      let result;
      switch (operator) {
        case '+':
          result = a + b;
          break;
        case '-':
          result = a - b;
          break;
        case '×':
        case '*':
        case 'x':
          result = a * b;
          break;
        case '÷':
        case '/':
          result = b !== 0 ? Math.floor(a / b) : 0;
          break;
        default:
          result = a + b;
      }

      return {
        question: match[0],
        a, b, operator,
        answer: result
      };
    }
  }

  // পেজের টেক্সট থেকে সংখ্যা খুঁজে বের করার চেষ্টা
  const numberPattern = /(\d+)\s*([+\-×*x÷/])\s*(\d+)/;
  const numMatch = html.match(numberPattern);
  if (numMatch) {
    const a = parseInt(numMatch[1]);
    const b = parseInt(numMatch[3]);
    return {
      question: numMatch[0],
      a, b,
      answer: a + b
    };
  }

  return null;
}

module.exports = { solveMathCaptcha };
