// כל חישובי הזמן/תאריך בשרת חייבים להיות בשעון ישראל (גם כש-Render רץ ב-UTC).
// חייב להיקבע לפני כל שימוש ב-Date / require שמשתמש בזמן.
process.env.TZ = 'Asia/Jerusalem';

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const url = require('url');

const PORT = process.env.PORT || 3000;

// ── Firestore ──
// KIOSK_ID מזהה את הקיוסק (למשל: chabad_jerusalem_doron)
// GOOGLE_CREDENTIALS — תוכן קובץ ה-JSON של Service Account (כ-Environment Variable ב-Render)
const KIOSK_ID = process.env.KIOSK_ID || 'chabad_jerusalem_doron';
let db = null;
let kioskDocRef = null;

async function initFirestore() {
  try {
    const { Firestore } = require('@google-cloud/firestore');
    const credsJson = process.env.GOOGLE_CREDENTIALS;
    if (!credsJson) { console.log('  ⚠ GOOGLE_CREDENTIALS לא מוגדר — עובד עם data.json מקומי'); return; }
    const credentials = JSON.parse(credsJson);
    db = new Firestore({ projectId: credentials.project_id, credentials });
    kioskDocRef = db.collection('kiosks').doc(KIOSK_ID);
    console.log(`  ✓ Firestore מחובר — קיוסק: ${KIOSK_ID}`);
  } catch(e) {
    console.log('  ⚠ Firestore לא זמין:', e.message, '— עובד עם data.json מקומי');
    db = null;
  }
}
const DATA_FILE = path.join(__dirname, 'data.json');

// ── ברירות מחדל ──
const DEFAULT_CATEGORY = "https://chabad.info/category/video/rebbe/%D7%9C%D7%A8%D7%90%D7%95%D7%AA-%D7%90%D7%AA-%D7%9E%D7%9C%D7%9B%D7%A0%D7%95/";
// "היום יום" מקומי — נטען מקובץ JSON שבונים פעם אחת מהקובץ של הרבי (תשרי–אב).
// עובד אופליין, חסין ל-Cloudflare ול-IP של Render. מפתח: חודש (שם hebcal) → יום (מספר) → טקסט.
let HAYOM_YOM_LOCAL = {};
try {
  HAYOM_YOM_LOCAL = require('./hayomyom.json');
  const days = Object.values(HAYOM_YOM_LOCAL).reduce((s,m)=>s+Object.keys(m).length,0);
  console.log(`  ✓ "היום יום" מקומי נטען (${Object.keys(HAYOM_YOM_LOCAL).length} חודשים, ${days} ימים)`);
} catch(e) {
  console.log('  ⚠ קובץ hayomyom.json לא נמצא — נופלים למקורות רשת:', e.message);
}
// מיפוי שמות חודשים של hebcal לשמות במפתח (כולל וריאציות שונות)
function localHayomYomMonthKey(hm) {
  if (HAYOM_YOM_LOCAL[hm]) return hm;
  const alias = {
    'Marcheshvan':'Cheshvan', 'Heshvan':'Cheshvan',
    'Shvat':"Sh'vat", 'Shevat':"Sh'vat",
    'Adar':'Adar II', 'Adar1':'Adar I', 'Adar2':'Adar II'  // בשנה פשוטה אדר → אדר ב' (מנהג היום יום)
  };
  const k = alias[hm];
  return (k && HAYOM_YOM_LOCAL[k]) ? k : null;
}
// מחזיר את טקסט "היום יום" של היום מהקובץ המקומי, או null אם אין ליום זה
async function getLocalHayomYom() {
  if (!HAYOM_YOM_LOCAL || !Object.keys(HAYOM_YOM_LOCAL).length) return null;
  const hd = await fetchHebrewDate();
  if (!hd || !hd.day || !hd.month) return null;
  const mk = localHayomYomMonthKey(hd.month);
  if (!mk) return null;
  const text = HAYOM_YOM_LOCAL[mk][hd.day] || HAYOM_YOM_LOCAL[mk][String(hd.day)];
  if (!text) return null;
  return { text, hebrewDate: `${hebrewDayLetters(hd.day)} ${HEB_MONTH_MAP[hd.month]||hd.month}` };
}

const HAYOMYOM_URL = "https://he.chabad.org/dailystudy/hayomyom_cdo/jewish/Hayom-Yom.htm";
const ZMANIM_RSS_URL = "https://he.chabad.org/tools/rss/zmanim.xml?locationId=247&locationType=1&bDef=0&before=40";
// גרסת סכימת הזמנים. כשמתקנים את אופן חישוב הזמן (כמו תיקון אזור-הזמן),
// מעלים את המספר — וזה מכריח רענון אחד אוטומטי גם אם ה-cache "של היום",
// כדי שערכים ישנים ושגויים (שנשמרו לפני התיקון) יוחלפו בלי עריכה ידנית ב-Firestore.
const ZMANIM_SCHEMA_VERSION = 2;
const CANDLE_ICS_URL = "https://he.chabad.org/calendar/candlelighting/candlelighting.ics.asp?locationId=247&locationType=1&lang=he";

// URL מרכזי של דף הלימוד היומי בעברית — לא בשימוש יותר (Cloudflare-blocked).
// מקור chabad.org.il הוסר משום שמוגן Cloudflare ולא ניתן לגירוד מ-Node.
// עברנו ל-Sefaria API שמספק את הלוח החב"די הרשמי בצורת JSON ללא הגנת אנטי-בוט.
// Sefaria API — diaspora=0 קריטי לבית כנסת בארץ ישראל.
// בלי הפרמטר Sefaria מחזירים ברירת מחדל של חו"ל, וכשארץ וחו"ל בקריאות שונות (אחרי פסח עד שמתאחדים) — תהיה טעות.
const SEFARIA_CALENDARS_URL = "https://www.sefaria.org/api/calendars?timezone=Asia/Jerusalem&diaspora=0";

// 7 שיעורים יומיים — תוויות בלבד. הערכים מתמלאים אוטומטית.
const DAILY_LEARNING_LABELS = [
  { key:'chumash',  label:'חומש' },
  { key:'tehillim', label:'תהילים' },
  { key:'tanya',    label:'תניא' },
  { key:'yom',      label:'היום יום' },
  { key:'rambam3',  label:'רמב״ם ג׳ פרקים' },
  { key:'rambam1',  label:'רמב״ם פרק ליום' },
  { key:'mitzvot',  label:'ספר המצוות' },
];

// מיפוי שם הכותרת ב-Sefaria (בעברית) למפתח הקיוסק
const SEFARIA_TITLE_MAP = {
  'פרשת השבוע':              'chumash',
  'הרמב"ם היומי':            'rambam1',
  'הרמב"ם היומי (3 פרקים)':   'rambam3',
  'תניא יומי':                'tanya',
};

// טבלת תהילים החב"די (30 ערכים) — לפי יום עברי בחודש
const TEHILLIM_DAILY = [
  "א׳-ט׳",       "י׳-י״ז",      "י״ח-כ״ב",    "כ״ג-כ״ח",    "כ״ט-ל״ד",
  "ל״ה-ל״ח",    "ל״ט-מ״ג",    "מ״ד-מ״ח",    "מ״ט-נ״ד",    "נ״ה-נ״ט",
  "ס׳-ס״ה",     "ס״ו-ס״ח",    "ס״ט-ע״א",    "ע״ב-ע״ו",    "ע״ז-ע״ח",
  "ע״ט-פ״ב",    "פ״ג-פ״ז",    "פ״ח-פ״ט",    "צ׳-צ״ו",     "צ״ז-ק״ג",
  "ק״ד-ק״ה",    "ק״ו-ק״ז",    "ק״ח-קי״ב",   "קי״ג-קי״ח",  "קי״ט א׳-מ״ב",
  "קי״ט מ״ג-ק״כ","קכ״א-קל״ד",  "קל״ה-קל״ט",  "ק״מ-קמ״ד",   "קמ״ה-ק״נ"
];

const ALIYAH_NAMES = ['ראשון','שני','שלישי','רביעי','חמישי','שישי','שביעי'];

const DEFAULTS = {
  videoUrl: "",              // override ידני (אופציונלי) — גובר על הרשימה
  videoTitle: "",
  videoSource: "chabad.info",
  categoryUrl: DEFAULT_CATEGORY,
  playlist: [],              // [{url,title}] — נבנה אוטומטית מהקטגוריה
  prayers: { shacharit:"07:00", mincha:"19:00", maariv:"20:30", farbrengen:"" },
  videoOffBeforePrayer: false, // כיבוי אוטומטי של הווידאו רבע שעה לפני שחרית/מנחה/ערבית
  birthdays: [],             // [{name, hmonth, hday}] — ברכת מזל טוב ביום ההולדת העברי
  torah: "",                 // override ידני להיום יום (אופציונלי)
  hayomYom: "",              // טקסט היום יום אוטומטי מ-chabad.org
  hayomYomDate: "",          // התאריך הלועזי של ה-hayomYom הנוכחי (לאיפוס יומי)
  zmanim: {},                // זמנים מ-chabad.org RSS (מפתח → ISO datetime)
  zmanimDate: "",            // התאריך הלועזי של הזמנים הנוכחיים
  candleEvents: [],          // [{type:'candle'|'havdalah', iso, summary, dateStr}] לכמה שבועות קדימה
  candleEventsDate: "",      // התאריך של הריענון האחרון
  dailyLearning: {},         // {chumash:{title,ref}, tehillim:{title,ref}, ...} מ-chabad.org.il
  dailyLearningDate: "",
  dailyLearningOverrides: {}, // {key:"ערך ידני"} — מנהל יכול לעקוף ערכים אוטומטיים
  haftarah: "",              // ההפטרה של השבוע, מ-Sefaria
  pithgam: "",               // "הפתגם היומי בעניני משיח וגאולה" — שדה ידני מהממשק
  viewingWindows: [],        // זמני צפייה שהגבאי מגדיר: [{start:"HH:MM", end:"HH:MM"}]. ריק = הווידאו לא פועל (ברירת מחדל)
  sponsorDaily:  { enabled:true, title:"חסות יומית",  body:"" },  // צד ימין, מתחת לזמני היום
  sponsorWeekly: { enabled:true, title:"חסות שבועית", body:"" },  // צד ימין, מתחת לזמני היום
  sponsorScreen: { enabled:true, title:"חסות המסך והמחשוב", body:"" }, // קבוע, רצועה תחתונה רחבה
  // איזה זמני יום להציג על המסך — שליטה מהממשק
  zmanimVisible: {
    alotHaShachar:true, misheyakir:true, sunrise:true, sofZmanShma:true,
    sofZmanTfilla:true, chatzot:true, minchaGedola:true, minchaKetana:true,
    plagHamincha:true, sunset:true, tzeit7083deg:true
  },
  // אילו שיעורי לימוד יומי להציג על המסך — שליטה מהממשק
  learningVisible: {
    chumash:true, tehillim:true, tanya:true, rambam3:true, rambam1:true, mitzvot:true
  },
  // הסתרה ליום אחד בלבד: מפתח מרחבי-שם → תאריך (YYYY-MM-DD). חוזר לבד למחרת.
  // דוגמה: { "z:sofZmanTfilla":"2026-06-02" } מסתיר את סוף זמן תפילה רק היום.
  hideToday: {},
  // אילו אזורים/בלוקים שלמים להציג על המסך — שליטה מהממשק (מנעד רחב לגבאי)
  sectionsVisible: {
    parasha:true, haftarah:true, zmanim:true, candle:true, learning:true,
    hayomyom:true, pithgam:true, prayers:true, donors:true,
    sponsors:true, memorial:true, video:true, roshChodesh:true
  },
  // תיבת "גולת הכותרת" — מתחת לזמני היום (חסות מרכזית)
  sponsorBox: { enabled:true, title:"גולת הכותרת", body:"" },
  // תיבת "לרפואה • לעילוי נשמה" — מתחת ללימוד יומי
  memorialBox: { enabled:true, title:"לרפואה • לעילוי נשמה", body:"" },
  items: [],
  donors: ["יעקב שומר", "גבריאל כנפו", "גרשון וובצ'יק", "עוזיאל בנציון חלק", "עודד מדבר", "אסתר שרה אטיאס", "רחל בן ציון", "אורה כהן", "רוני רונית דהאן", "מרים זיגמן", "יניב חתניאן", "שמואל מרחבי", "יהודה גבריאל לוגסי", "מנחם מענדל אמיתי", "רות רותם אלקיים", "יאיר זוטא", "ניצה רוחמה אמיתי", "נחשון אדרעי", "ליאור דוד שמיע", "טל מלמד", "מנחם בר כוכבא", "מיכאל עזרן", "מנחם מענדל פרידמן", "יעקב טרויאנוב", "שולי קושיצקי", "ליאור עזוז", "אברהם קדוש", "אדי אהרון דב סטודניץ", "שמאי שבייב", "עוז שאמו כהן", "איתן חנניה נימן", "יוסף יצחק סיבוני", "איתן אברהם ביטון", "שי שאולי", "אוריאל מימון לוינזון", "רפאל סילמן", "קרן בן טולילה", "יוסף צבי הירש פלדמן", "סיגלית מתיתיהו", "דוד לסרי", "שמואל עומרי כורך", "אורנה מור סלבדור", "שמוליק מיכאל", "בנימין משה", "ישראל בנעט", "בן ציון שיפתין", "משה שורין", "דוד רוזן", "עמיקם שוורץ", "נועם ישראל הרפז", "יוכבד הוכשטיין", "איתי אברומביץ", "אילנה רעננה", "מנחם מענדל שלמה יואב שרגא שמידע", "אסתר מנדלובי'ץ", "אורלי חנה חלק", "נתנאל אדיר", "איריס אמסלם", "מנחם מענדל גינזבורג", "יניב כהן", "יוסף דוד מנחם מירלסון", "הראל שטרית", "אליעזר זוסיא ברוק", "אופיר חבשוש", "שלמה קאליש", "עופרה אביגיל שוהם", "דניאל יוסף ליטבק", "אלישבע גרינצוויג", "אמיר בן ישי", "מאיר הכהן זינגר", "לאה עזריאל", "רונן גלעד", "מתתיהו שובל", "ינון סיביליה", "רינה אירינה דולב", "אורה אירית סיני", "יצחק וירט", "רון קולטון", "יחיאל קופצ'יק", "יוסף כהן", "אלכסנדר שמחה ניסמן", "אביתר ישר", "תומר גורדו", "יוסף יצחק שי", "יעל בן חיים", "חנן יעקב לב", "יוסף יהודה הכהן ריבק", "דינה אריאל", "אברהם כהן", "תמי מרציאנו", "לוי יצחק אליאס", "עליזה אילוז", "אריאל נגר", "זוהרה יהודית חבשוש", "מנחם מענדל דונין", "זאב וולף וולמן", "לירן גביש", "איֶילת עמר", "זיוה גדרון", "מיכאל קויפמן", "עמיחי עזרא", "אליסף הייפרט", "יוסף מרדכי קורניצר", "אליהו שמעון מנחם כהן", "זאב יהודה ברנשטוק", "מנחם מענדל ציון חלק", "חנה לוי גו'ליאן", "פופ מארש יוני בן ישי", "בועז קלימי", "אריה לוי", "אורן הכהן כהן", "אסתר אשכנזי", "מרדכי בן שמעון", "תמר ציפורה וייס", "אילין ריבקה סמיט", "דורון יניב", "ניסים ניסימיאן", "אלכס אדלברג", "אליהו סלמן", "Nir Hakim", "אלעד צפניה", "מנחם מענדל גדליה הכהן רוזנפלד", "נריה אייזיק הכהן זינגר", "אילי לוינזון", "יאיר רחמים גלפנד", "פנחס הלוי גרוסמן", "נחמה שבייב", "תמר צח", "ליאור עדיקה", "אסתר נעים", "דוד עוליאל", "איליה וולקוב", "שלמה יצחק מולר", "אוסנת רבקה גנני", "יותם יוסף טסלר", "רחל שירה סיבוני", "אוהד דאהן", "שלום שמעון פרץ", "הדסה ברוכמן", "ינון גלעדי", "אברהם משה אורן", "יעל אלון", "דניאל רפאל וירצברגר", "אורלי אפרת", "גיא אלול", "אבינועם סימני", "אהרון אלינוי", "יעקב פינחס טל", "נתנאל מוטהדה", "שלמה נתיב", "יורם חיים שוהם", "ישראל נתן פערקל", "יהלי משה דה מדינה", "יפתח הלל פולצ'ק", "יואל יוסף יום טוב אסולין", "קתיה ורד שטפנסקי", "אליהו פרץ", "אליהו הורביץ", "חביב שליבה", "ישי ונגרובסקי", "זורה ליאורה פרנץ", "משה הכהן כהן", "חנוך ערנטרוי", "אושרית טוני חדד", "עובדיה מנשה(עודי) אנטיאן", "שמחה ווברמן", "הנרי יעקב בנטולילה", "אברהם מאיר לייטר", "נתן קרא-איונוב", "אוסנת חלק", "אתי דדוש", "מיכאל חטב", "שלום כהן", "יצחק מהודר", "רות רוזה דוידוביץ", "אייל שמואל בוגט", "יואב ברקאי", "יחזקאל דוד גרינשטיין", "יונה פיזם", "דוד אטל", "גיא מינץ", "אפרת איריס לוין", "מנחם נמדר[דניג'מס]"]  // מאגר התורמים — ניתן לעריכה מהממשק (נטען ראשונית מ-CSV)
};

// ── טעינה ושמירה — Firestore אם זמין, אחרת data.json ──
let _cachedData = null; // cache בזיכרון כדי שלא נחכה ל-Firestore בכל קריאה

function loadData() {
  // תמיד מחזיר מה-cache (מתעדכן אסינכרוני ב-loadDataAsync)
  if (_cachedData) return {...DEFAULTS, ..._cachedData};
  // fallback: data.json מקומי
  try {
    if (fs.existsSync(DATA_FILE)) {
      const saved = JSON.parse(fs.readFileSync(DATA_FILE,'utf8'));
      return {...DEFAULTS, ...saved};
    }
  } catch(e) {}
  return {...DEFAULTS};
}

async function loadDataAsync() {
  if (db && kioskDocRef) {
    try {
      const snap = await kioskDocRef.get();
      const saved = snap.exists ? snap.data() : {};
      _cachedData = saved;
      return {...DEFAULTS, ...saved};
    } catch(e) {
      console.log('  ⚠ שגיאת Firestore בטעינה:', e.message);
    }
  }
  // fallback: data.json
  try {
    if (fs.existsSync(DATA_FILE)) {
      const saved = JSON.parse(fs.readFileSync(DATA_FILE,'utf8'));
      _cachedData = saved;
      return {...DEFAULTS, ...saved};
    }
  } catch(e) {}
  return {...DEFAULTS};
}

function saveData(d) {
  _cachedData = d; // עדכן cache מיידית
  if (db && kioskDocRef) {
    // שמור ל-Firestore אסינכרונית
    kioskDocRef.set(d, {merge: true}).catch(e => console.log('  ⚠ שגיאת Firestore בשמירה:', e.message));
  } else {
    // fallback: data.json
    try { fs.writeFileSync(DATA_FILE, JSON.stringify(d, null, 2), 'utf8'); } catch(e) {}
  }
}

// ── חילוץ MP4 מ-chabad.info ──
// ── הורדת HTML עם timeout ומעקב אחרי הפניות ──
function fetchHtml(pageUrl, redirects=0) {
  return new Promise((resolve, reject) => {
    let reqUrl;
    try { reqUrl = new URL(pageUrl); } catch(e) { return reject(new Error('כתובת לא תקינה')); }
    const lib = reqUrl.protocol === 'http:' ? http : https;
    const options = {
      hostname: reqUrl.hostname,
      path: reqUrl.pathname + reqUrl.search,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'Accept-Language': 'he,en-US;q=0.9,en;q=0.8',
        'Cache-Control': 'no-cache',
        'Pragma': 'no-cache',
        'Upgrade-Insecure-Requests': '1',
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Site': 'none',
        'Sec-Fetch-User': '?1'
      }
    };
    const r = lib.get(options, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects < 5) {
        res.resume();
        const next = new URL(res.headers.location, reqUrl).href;
        return fetchHtml(next, redirects + 1).then(resolve).catch(reject);
      }
      let html = '';
      res.setEncoding('utf8');
      res.on('data', c => html += c);
      res.on('end', () => resolve(html));
    });
    r.on('error', reject);
    r.setTimeout(15000, () => r.destroy(new Error('timeout')));
  });
}

function decodeEntities(s) {
  return String(s)
    .replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&#8217;/g, '’')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ');
}

function extractMP4(html) {
  let m = html.match(/https?:\/\/media\.chabad\.info\/[^\s"'<>]+\.mp4/i);
  if (!m) m = html.match(/https?:\/\/[^\s"'<>]+\.mp4/i);
  return m ? m[0].trim() : null;
}

function extractTitle(html) {
  let m = html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i);
  if (m) return decodeEntities(m[1].trim());
  m = html.match(/<h1[^>]*>([^<]+)<\/h1>/);
  return m ? decodeEntities(m[1].trim()) : 'סרטון הרבי';
}

// מוצא את כתובות עמודי הוידאו מתוך דף קטגוריה (לפי סדר הופעה — החדשים ראשונים)
function extractVideoLinks(html) {
  const out = [], seen = new Set();
  const re = /https?:\/\/(?:www\.)?chabad\.info\/video\/[^\s"'<>]*?\/(\d{4,})(?=[\/"'\s<>?#])/gi;
  let m;
  while ((m = re.exec(html))) {
    let u = m[0].replace(/[#?].*$/, '');
    if (!u.endsWith('/')) u += '/';
    if (!seen.has(u)) { seen.add(u); out.push(u); }
  }
  return out;
}

// חילוץ MP4 מעמוד וידאו בודד
async function fetchMP4fromChabadInfo(pageUrl) {
  const html = await fetchHtml(pageUrl);
  const mp4 = extractMP4(html);
  if (mp4) return { mp4, title: extractTitle(html) };
  const jw = html.match(/mediaid[=:"'\s]+(\d+)/i);
  if (jw) return { mp4: null, mediaid: jw[1], title: extractTitle(html), note: 'jwplayer' };
  throw new Error('לא נמצא קובץ וידאו בדף');
}

// בונה רשימת השמעה מדף קטגוריה
async function buildPlaylist(categoryUrl, limit = 8) {
  const html = await fetchHtml(categoryUrl);
  const links = extractVideoLinks(html).slice(0, limit);
  const playlist = [];
  for (const link of links) {
    try {
      const r = await fetchMP4fromChabadInfo(link);
      if (r && r.mp4) playlist.push({ url: r.mp4, title: r.title || '', page: link });
    } catch(e) { /* דלג על עמוד שאין בו וידאו ישיר */ }
  }
  return playlist;
}

// מרענן את הרשימה ושומר ל-data.json (לא מוחק רשימה קיימת אם לא נמצא כלום)
async function refreshPlaylist() {
  const data = loadData();
  const cat = data.categoryUrl || DEFAULT_CATEGORY;
  try {
    const pl = await buildPlaylist(cat, 8);
    if (pl.length) {
      data.playlist = pl;
      saveData(data);
      console.log(`  ✓ רשימת וידאו עודכנה: ${pl.length} סרטונים`);
    } else {
      console.log('  ⚠ לא נמצאו סרטונים ישירים — נשמרת הרשימה הקיימת');
    }
    return pl.length;
  } catch(e) {
    console.log('  ⚠ רענון רשימה נכשל:', e.message);
    return 0;
  }
}

// ── חילוץ טקסט "היום יום" מ-he.chabad.org ──
const BUILD_VERSION = "v8-nocache";

function todayKey() {
  const n = new Date();
  return `${n.getFullYear()}-${(n.getMonth()+1).toString().padStart(2,'0')}-${n.getDate().toString().padStart(2,'0')}`;
}

function stripTags(s) {
  return String(s)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h\d)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ');
}

function normalizeText(s) {
  return decodeEntities(stripTags(s))
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/^\s+|\s+$/g, '');
}

async function fetchHayomYom() {
  const html = await fetchHtml(HAYOMYOM_URL);

  // ניסיון 1: בלוק JSON-LD שמכיל את גוף המאמר
  const ld = html.match(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/i);
  if (ld) {
    try {
      const j = JSON.parse(ld[1]);
      const arr = Array.isArray(j) ? j : [j];
      for (const o of arr) {
        const body = o && (o.articleBody || o.description || o.text);
        if (typeof body === 'string' && body.trim().length > 60) return normalizeText(body);
      }
    } catch(e) {}
  }

  // ניסיון 2: container רגיל של chabad.org עם תוכן מאמר
  const containers = [
    /<div[^>]+class="[^"]*(?:cdoArticleText|article-text|article-content|article-body|articleBody)[^"]*"[^>]*>([\s\S]*?)<\/div>\s*(?:<\/div>|<aside|<footer)/i,
    /<article[^>]*>([\s\S]*?)<\/article>/i,
    /<div[^>]+id=["'](?:article-content|main-content|article-body)["'][^>]*>([\s\S]*?)<\/div>/i,
    /<main[^>]*>([\s\S]*?)<\/main>/i,
  ];
  for (const re of containers) {
    const m = html.match(re);
    if (m) {
      const txt = normalizeText(m[1]);
      if (txt.length > 60) return txt;
    }
  }

  // ניסיון 3: og:description — לרוב תקציר, לא טקסט מלא, אבל עדיף מכלום
  const og = html.match(/<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']{60,})["']/i);
  if (og) return decodeEntities(og[1]).trim();

  // ניסיון 4: הפיסקה הארוכה ביותר ב-HTML (גישה גנרית כשלוט יודעים את ה-class)
  const paragraphs = [...html.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/gi)]
    .map(m => normalizeText(m[1]))
    .filter(t => t.length > 80 && /[א-ת]/.test(t)); // צריך להכיל אותיות עבריות
  if (paragraphs.length) {
    paragraphs.sort((a,b) => b.length - a.length);
    // קח עד 3 הפיסקאות הארוכות ביותר ושרשר
    const top = paragraphs.slice(0, 3).join('\n\n');
    if (top.length > 60) return top;
  }

  throw new Error('לא נמצא טקסט "היום יום" בדף — מבנה הדף השתנה');
}

// שומר תקינות ל"היום יום": דוחה דפי חסימה של Cloudflare / טקסט לא-עברי,
// כדי שדף "Enable JavaScript and cookies to continue" לא יישמר וירעיל את ה-cache.
function isValidHayomYom(text) {
  if (!text || typeof text !== 'string') return false;
  const t = text.trim();
  if (t.length < 25) return false;
  // דפי אנטי-בוט / Cloudflare / "Just a moment"
  if (/enable javascript|cookies to continue|just a moment|attention required|checking your browser|verify you are human|cloudflare|cf-browser|please wait|ddos/i.test(t)) return false;
  // חייב להכיל תוכן עברי משמעותי (לפחות 8 אותיות עבריות)
  if ((t.match(/[\u05D0-\u05EA]/g) || []).length < 8) return false;
  return true;
}

async function refreshHayomYom() {
  const today = todayKey();
  const data = loadData();
  // אם ה-cache תקף *ותקין* — אל תרענן. אם הוא מורעל (דף חסימה ישן), התעלם ורענן.
  if (data.hayomYomDate === today && isValidHayomYom(data.hayomYom)) return { ok:true, cached:true };

  // מקור ראשי: קובץ "היום יום" מקומי (עובד תמיד, גם ב-Render). חסין ל-Cloudflare.
  try {
    const local = await getLocalHayomYom();
    if (local && isValidHayomYom(local.text)) {
      data.hayomYom = local.text;
      data.hayomYomDate = today;
      data.hayomYomSource = 'local';
      saveData(data);
      console.log(`  ✓ "היום יום" עודכן מהקובץ המקומי (${local.hebrewDate}, ${local.text.length} תווים)`);
      return { ok:true, length: local.text.length, source:'local' };
    }
    if (!local) console.log('  ⚠ אין ערך מקומי ליום זה (כנראה אלול/יום חסר בקובץ) — מנסה רשת');
  } catch(eLocal) {
    console.log('  ⚠ קריאת היום יום מקומי נכשלה:', eLocal.message, '— מנסה רשת');
  }

  // מקור גיבוי: Chabadpedia תבנית ישירה (עובד מ-IP ישראלי, חסום ב-Render)
  try {
    const result = await fetchHayomYomFromChabadpedia();
    if (!isValidHayomYom(result.text)) throw new Error('תוכן Chabadpedia נראה כדף חסימה / לא תקין');
    data.hayomYom = result.text;
    data.hayomYomDate = today;
    data.hayomYomSource = result.url;
    saveData(data);
    console.log(`  ✓ "היום יום" עודכן מ-Chabadpedia (${result.hebrewDate}, ${result.text.length} תווים)`);
    return { ok:true, length: result.text.length, source:'chabadpedia' };
  } catch(e1) {
    console.log('  ⚠ Chabadpedia נכשל:', e1.message, '— מנסה chabad.fm');
  }

  // גיבוי: chabad.fm — מקור פתוח עם היום יום יומי
  try {
    const hd = await fetchHebrewDate();
    const fmUrl = `https://www.chabad.fm/${hd.day + (hd.month === 'Nisan' ? 0 : 0)}/`; // URL לפי יום בשנה
    // chabad.fm מספר ימים מתחילת השנה — נחשב
    const monthOrder = ['Tishrei','Cheshvan','Marcheshvan','Heshvan','Kislev','Tevet','Sh\'vat','Shvat','Shevat','Adar','Adar I','Adar1','Nisan','Iyyar','Sivan','Tamuz','Av','Elul'];
    const monthDays =  [30,       29,        29,           29,       30,      29,     30,       30,     30,      29,     30,       30,      30,     29,     30,     29,     30,   29];
    let dayOfYear = hd.day;
    for (let i = 0; i < monthOrder.length; i++) {
      if (monthOrder[i] === hd.month) break;
      dayOfYear += monthDays[i];
    }
    const fmUrlFinal = `https://www.chabad.fm/${dayOfYear}/`;
    const html = await fetchHtml(fmUrlFinal);
    // חלץ מ-<div class="hayom-yom"> או תג דומה
    const m = html.match(/<div[^>]*class="[^"]*(?:hayom|yom-yom|content)[^"]*"[^>]*>([\s\S]{30,800}?)<\/div>/i);
    if (m) {
      const txt = normalizeText(m[1]).trim();
      if (isValidHayomYom(txt)) {
        data.hayomYom = txt;
        data.hayomYomDate = today;
        saveData(data);
        console.log(`  ✓ "היום יום" עודכן מ-chabad.fm (${txt.length} תווים)`);
        return { ok:true, length: txt.length, source:'chabad.fm' };
      }
    }
    throw new Error('לא נמצא תוכן ב-chabad.fm');
  } catch(e2) {
    console.log('  ⚠ chabad.fm נכשל:', e2.message);
  }

  // גיבוי אחרון: chabad.org
  try {
    const txt = await fetchHayomYom();
    if (!isValidHayomYom(txt)) throw new Error('תוכן chabad.org נראה כדף חסימה / לא תקין');
    data.hayomYom = txt;
    data.hayomYomDate = today;
    saveData(data);
    console.log(`  ✓ "היום יום" עודכן מ-chabad.org (${txt.length} תווים)`);
    return { ok:true, length: txt.length, source:'chabad.org' };
  } catch(e3) {
    console.log('  ⚠ רענון "היום יום" נכשל לחלוטין:', e3.message);
    return { ok:false, error: e3.message };
  }
}

// ── תזמון עדכון יומי ב-6:00 בבוקר שעון ישראל ──
function scheduleDaily6am(fn, label) {
  function msUntil6am() {
    const now = new Date();
    // 6:00 שעון ישראל = UTC+3 בקיץ = 3:00 UTC
    const next = new Date(now);
    next.setUTCHours(3, 0, 0, 0); // 3:00 UTC = 6:00 ישראל
    if (next <= now) next.setUTCDate(next.getUTCDate() + 1);
    return next - now;
  }
  function schedule() {
    const ms = msUntil6am();
    const hrs = (ms / 3600000).toFixed(1);
    console.log(`  ⏰ ${label} יתעדכן בעוד ${hrs} שעות (6:00 ישראל)`);
    setTimeout(() => {
      fn();
      setInterval(fn, 24 * 60 * 60 * 1000);
    }, ms);
  }
  schedule();
}

// ── זמנים מ-RSS של chabad.org ──
// מיפוי שם השדה ב-RSS למפתחות שהקיוסק כבר משתמש בהם (sunrise, sunset וכו')
const ZMANIM_RSS_MAP = {
  'עלות השחר':                            'alotHaShachar',
  'זמן טלית ותפילין המוקדם ביותר':         'misheyakir',
  'זריחה':                                'sunrise',
  'סוף זמן קריאת שמע':                    'sofZmanShma',
  'סוף זמן תפילת שחרית':                  'sofZmanTfilla',
  'חצות (היום)':                          'chatzot',
  'המנחה המוקדמת':                        'minchaGedola',
  'מנחה קטנה':                            'minchaKetana',
  'פלג המנחה':                            'plagHamincha',
  'שקיעת החמה':                           'sunset',
  'לילה':                                 'tzeit7083deg', // תואם למפתח הקיים בקיוסק
  'חצות הלילה':                           'chatzotNight'
};

// פרסר RSS פשוט: מחלץ את ה-<item>-ים. בלי תלויות.
function parseRssItems(xml) {
  const items = [];
  const re = /<item>([\s\S]*?)<\/item>/gi;
  let m;
  while ((m = re.exec(xml))) {
    const block = m[1];
    const title = (block.match(/<title>([\s\S]*?)<\/title>/) || [])[1] || '';
    const cat   = (block.match(/<category>([\s\S]*?)<\/category>/) || [])[1] || '';
    items.push({ title: decodeEntities(title).trim(), category: cat.trim() });
  }
  return items;
}

// HH:MM → ISO datetime של היום (או למחרת אם השעה לפני 4:00 בבוקר ויותר סביר שזו "חצות הלילה")
function hhmmToIso(hhmm, baseDate) {
  const mm = hhmm.match(/^(\d{1,2}):(\d{2})/);
  if (!mm) return null;
  const h = parseInt(mm[1], 10), min = parseInt(mm[2], 10);
  if (h < 0 || h > 23 || min < 0 || min > 59) return null;
  const d = new Date(baseDate);
  d.setHours(h, min, 0, 0);
  return d.toISOString();
}

async function fetchChabadZmanim() {
  const xml = await fetchHtml(ZMANIM_RSS_URL);
  if (!xml || xml.length < 200 || !xml.includes('<rss')) {
    throw new Error('RSS לא חוקי או ריק');
  }
  const items = parseRssItems(xml);
  if (!items.length) throw new Error('לא נמצאו פריטים ב-RSS');

  const zmanim = {};
  const today = new Date();
  today.setHours(0,0,0,0);

  for (const it of items) {
    // השמט את "שעה זמנית" — זה משך, לא נקודת זמן (מסומן ב"דקות" ב-category)
    if (/דקות/.test(it.category)) continue;

    // חלץ את שם הזמן מה-title: "<name> - HH:MM -- (date)"
    let nameWithAlt = it.title.replace(/\s*-\s*\d{1,2}:\d{2}.*$/, '').trim();
    // הסר שם חלופי בסוגריים — חוץ מ"חצות (היום)" ו"חצות הלילה" שמובדלים דווקא ע"י הסוגריים
    let key = ZMANIM_RSS_MAP[nameWithAlt];
    if (!key) {
      const baseName = nameWithAlt.replace(/\s*\([^)]*\)\s*$/, '').trim();
      key = ZMANIM_RSS_MAP[baseName];
    }
    if (!key) continue;

    const iso = hhmmToIso(it.category, today);
    if (iso) zmanim[key] = iso;
  }
  return zmanim;
}

async function refreshZmanim() {
  const today = todayKey();
  const data = loadData();
  // אם עודכן היום, יש זמנים, *והגרסה תואמת* — אין צורך. אחרת מרעננים (כולל ערכים ישנים שגויים).
  if (data.zmanimDate === today && data.zmanim && Object.keys(data.zmanim).length && data.zmanimVersion === ZMANIM_SCHEMA_VERSION) {
    return { ok:true, cached:true, count: Object.keys(data.zmanim).length };
  }
  try {
    const z = await fetchChabadZmanim();
    data.zmanim = z;
    data.zmanimDate = today;
    data.zmanimVersion = ZMANIM_SCHEMA_VERSION;
    saveData(data);
    console.log(`  ✓ זמנים עודכנו (${Object.keys(z).length} זמנים מ-chabad.org)`);
    return { ok:true, count: Object.keys(z).length };
  } catch(e) {
    console.log('  ⚠ רענון זמנים נכשל:', e.message);
    return { ok:false, error: e.message };
  }
}

// ── הדלקת נרות וצאת השבת מקובץ ICS של chabad.org ──
function parseIcs(text) {
  // איחוי שורות מקופלות לפי RFC 5545: שורה שמתחילה ברווח/טאב היא המשך הקודמת
  const unfolded = String(text).replace(/\r?\n[ \t]/g, '');
  const lines = unfolded.split(/\r?\n/);
  const events = [];
  let cur = null;
  for (const line of lines) {
    if (line === 'BEGIN:VEVENT') { cur = {}; continue; }
    if (line === 'END:VEVENT')   { if (cur) events.push(cur); cur = null; continue; }
    if (!cur) continue;
    const idx = line.indexOf(':');
    if (idx < 0) continue;
    const left = line.substring(0, idx);
    const value = line.substring(idx + 1);
    const [keyName, ...params] = left.split(';');
    const entry = { value, params: {} };
    for (const p of params) {
      const eq = p.indexOf('=');
      if (eq > 0) entry.params[p.substring(0, eq).toUpperCase()] = p.substring(eq + 1);
    }
    cur[keyName.toUpperCase()] = entry;
  }
  return events;
}

function icsDateToIso(prop) {
  if (!prop) return null;
  const v = prop.value || '';
  // YYYYMMDDTHHMMSSZ (UTC)
  let m = v.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/);
  if (m) return new Date(Date.UTC(+m[1], +m[2]-1, +m[3], +m[4], +m[5], +m[6])).toISOString();
  // YYYYMMDDTHHMMSS (זמן מקומי של המכונה — בישראל זה זמן ישראל)
  m = v.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})$/);
  if (m) return new Date(+m[1], +m[2]-1, +m[3], +m[4], +m[5], +m[6]).toISOString();
  // YYYYMMDD (תאריך בלבד)
  m = v.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (m) return new Date(+m[1], +m[2]-1, +m[3], 0, 0, 0).toISOString();
  return null;
}

function classifyCandle(summary) {
  const s = String(summary || '');
  if (/הדלקת\s*נרות|candle\s*lighting/i.test(s)) return 'candle';
  if (/צאת\s*(?:השבת|החג)|הבדלה|havdalah|shabbat\s*ends|holiday\s*ends/i.test(s)) return 'havdalah';
  return 'other';
}

async function fetchChabadCandleLighting() {
  const ics = await fetchHtml(CANDLE_ICS_URL);
  if (!ics || !ics.includes('BEGIN:VCALENDAR')) throw new Error('ICS לא חוקי או ריק');
  const events = parseIcs(ics);
  if (!events.length) throw new Error('לא נמצאו אירועים ב-ICS');

  const out = [];
  for (const e of events) {
    const rawSummary = (e.SUMMARY && e.SUMMARY.value) || '';
    // ICS עוטף תווים מיוחדים: \, → , ; \; → ; ; \n → newline ; \\ → \
    const summary = decodeEntities(rawSummary
      .replace(/\\,/g, ',').replace(/\\;/g, ';')
      .replace(/\\n/gi, '\n').replace(/\\\\/g, '\\').trim());
    const iso = icsDateToIso(e.DTSTART);
    if (!iso) continue;
    const type = classifyCandle(summary);
    if (type === 'other') continue;
    out.push({ type, iso, summary });
  }
  out.sort((a, b) => new Date(a.iso) - new Date(b.iso));
  return out;
}

async function refreshCandleLighting() {
  const today = todayKey();
  const data = loadData();
  if (data.candleEventsDate === today && Array.isArray(data.candleEvents) && data.candleEvents.length) {
    return { ok:true, cached:true, count: data.candleEvents.length };
  }
  try {
    const all = await fetchChabadCandleLighting();
    const cutoff = new Date(); cutoff.setHours(0, 0, 0, 0);
    const future = all.filter(e => new Date(e.iso) >= cutoff);
    data.candleEvents = future;
    data.candleEventsDate = today;
    saveData(data);
    console.log(`  ✓ הדלקת נרות עודכן (${future.length} אירועים עתידיים)`);
    return { ok:true, count: future.length };
  } catch(e) {
    console.log('  ⚠ רענון הדלקת נרות נכשל:', e.message);
    return { ok:false, error: e.message };
  }
}

// ── לימוד יומי דרך Sefaria API ──
// (chabad.org/chabad.org.il חסומים Cloudflare. Sefaria מציעים את אותו לוח חב"די ב-JSON.)
function fetchJson(url) {
  return fetchHtml(url).then(text => {
    try { return JSON.parse(text); }
    catch(e) { throw new Error('JSON parse failed: ' + e.message); }
  });
}

// תאריך עברי של היום (יום בחודש 1-30) — דרך Hebcal converter API
async function fetchHebrewDay() {
  const n = new Date();
  const url = `https://www.hebcal.com/converter?cfg=json&gy=${n.getFullYear()}&gm=${n.getMonth()+1}&gd=${n.getDate()}&g2h=1`;
  const json = await fetchJson(url);
  return json.hd || null; // יום עברי בחודש
}

// ספר המצוות היומי — דרך Hebcal (dsm=on). מחזיר תווית קצרה כמו "לא תעשה רט״ז".
function addGershayim(heb) {
  // הוסף גרש/גרשיים למספר עברי (רטז → רט״ז, ה → ה׳)
  const s = (heb || '').replace(/["'״׳]/g, '').trim();
  if (!s) return heb;
  if (s.length === 1) return s + '\u05f3';            // גרש
  return s.slice(0, -1) + '\u05f4' + s.slice(-1);     // גרשיים לפני האות האחרונה
}
// המרת מספר (1-400) לאותיות עבריות (גימטריה), למשל 216 → "רטז"
function numToHebrew(num) {
  if (!num || num < 1) return '';
  const H = [
    [400,'ת'],[300,'ש'],[200,'ר'],[100,'ק'],
    [90,'צ'],[80,'פ'],[70,'ע'],[60,'ס'],[50,'נ'],[40,'מ'],[30,'ל'],[20,'כ'],[10,'י'],
    [9,'ט'],[8,'ח'],[7,'ז'],[6,'ו'],[5,'ה'],[4,'ד'],[3,'ג'],[2,'ב'],[1,'א']
  ];
  let n = num, out = '';
  for (const [v,ch] of H) { while (n >= v) { out += ch; n -= v; } }
  // תיקון צורות מיוחדות: טו/טז במקום יה/יו
  out = out.replace(/יה/g,'טו').replace(/יו/g,'טז');
  return out;
}
async function fetchSeferMitzvot() {
  const n = new Date();
  const y = n.getFullYear(), m = n.getMonth()+1, d = n.getDate();
  const ds = `${y}-${String(m).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
  const url = `https://www.hebcal.com/hebcal?v=1&cfg=json&dsm=on&start=${ds}&end=${ds}&geo=none`;
  const json = await fetchJson(url);
  const items = (json && json.items) || [];
  for (const it of items) {
    const t = it.title || it.hebrew || '';
    // Hebcal מחזיר באנגלית: "Day 120: N216" (Negative=לא תעשה) או "...: P12" (Positive=עשה)
    // ייתכנו כמה מצוות: "N215, N216" וכו'
    const matches = [...t.matchAll(/([PN])\s*(\d+)/gi)];
    if (!matches.length) continue;
    const parts = matches.map(mt => {
      const kind = mt[1].toUpperCase() === 'P' ? 'עשה' : 'לא תעשה';
      const heb = addGershayim(numToHebrew(parseInt(mt[2], 10)));
      return `${kind} ${heb}`;
    });
    return parts.join(', ');
  }
  return null;
}

async function refreshDailyLearning() {
  const today = todayKey();
  const data = loadData();
  if (data.dailyLearningDate === today && data.dailyLearning && Object.keys(data.dailyLearning).length) {
    const okCount = Object.values(data.dailyLearning).filter(x=>x&&x.ref).length;
    const hasMitzvot = data.dailyLearning.mitzvot && data.dailyLearning.mitzvot.ref;
    if (okCount >= 4 && hasMitzvot) return { ok:true, cached:true, count: okCount };
  }

  // אתחל את כל 7 השדות במצב ריק
  const result = {};
  for (const L of DAILY_LEARNING_LABELS) result[L.key] = { label: L.label, ref: null };

  // 1) Sefaria: חומש (פרשה+עליה), תניא, רמב"ם 1, רמב"ם 3, הפטרה
  try {
    const json = await fetchJson(SEFARIA_CALENDARS_URL);
    const items = json.calendar_items || [];
    for (const item of items) {
      const heTitle = (item.title && item.title.he) || '';
      // הפטרה — נשמר בשדה נפרד, לא ברשימת לימוד יומי
      if (heTitle === 'הפטרה') {
        const val = (item.displayValue && item.displayValue.he) || '';
        if (val) data.haftarah = val;
        continue;
      }
      const key = SEFARIA_TITLE_MAP[heTitle];
      if (!key) continue;
      const val = (item.displayValue && item.displayValue.he) || '';
      if (key === 'chumash' && item.extraDetails && Array.isArray(item.extraDetails.aliyot)) {
        // לפי מנהג חב"ד: ראשון=עליה 1, ..., שבת=עליה 7
        const dow = new Date().getDay(); // 0=ראשון
        const aliyahIdx = Math.min(dow, 6);
        result.chumash.ref = `${val} — ${ALIYAH_NAMES[aliyahIdx]}`;
      } else {
        // אם כבר יש ערך — צרף (קורה כשהרמב"ם היומי חוצה גבול ספר/הלכה)
        result[key].ref = result[key].ref ? `${result[key].ref} + ${val}` : val;
      }
    }
  } catch(e) {
    console.log('  ⚠ Sefaria נכשל:', e.message);
  }

  // 2) תהילים — מקומית מטבלת ה-30 ימים החב"דית
  try {
    const day = await fetchHebrewDay();
    if (day) {
      const idx = Math.min(Math.max(day - 1, 0), 29);
      result.tehillim.ref = `פרקים ${TEHILLIM_DAILY[idx]}`;
    }
  } catch(e) {
    console.log('  ⚠ חישוב תהילים נכשל:', e.message);
  }

  // 3) היום יום: אם יש טקסט תקין מ-Chabadpedia (נשמר ב-data.hayomYom), הצג סיכום קצר ב-yom
  if (isValidHayomYom(data.hayomYom) && data.hayomYomDate === today) {
    const preview = data.hayomYom.split(/\n/)[0].substring(0, 80);
    result.yom.ref = preview + (data.hayomYom.length > 80 ? '...' : '');
  }
  // 4) ספר המצוות היומי — דרך Hebcal (dsm). מחזיר תווית קצרה.
  try {
    const sm = await fetchSeferMitzvot();
    if (sm) result.mitzvot.ref = sm;
  } catch(e) {
    console.log('  ⚠ ספר המצוות (Hebcal) נכשל:', e.message);
  }

  data.dailyLearning = result;
  data.dailyLearningDate = today;
  saveData(data);
  const okCount = Object.values(result).filter(x => x && x.ref).length;
  console.log(`  ✓ לימוד יומי עודכן (${okCount}/${DAILY_LEARNING_LABELS.length} מקורות הצליחו)`);
  return { ok: okCount > 0, count: okCount, total: DAILY_LEARNING_LABELS.length };
}

// ── היום יום מ-Chabadpedia ──
// Chabadpedia מארחים תבנית לכל יום ב-URL הצורה:
//   /index.php?title=תבנית:היום_יום/{HEBREW_DAY}_{HEBREW_MONTH}
// למשל: י"ג_סיון, ה'_סיון, ט"ו_אדר_א
// חוץ מ-15/16 (שמיוצגים ט"ו/ט"ז) זה גימטריה רגילה.

const HEB_MONTH_MAP = {
  'Nisan':'ניסן', 'Iyyar':'אייר', 'Sivan':'סיון', 'Tamuz':'תמוז',
  'Av':'אב', 'Elul':'אלול', 'Tishrei':'תשרי',
  'Cheshvan':'חשוון', 'Marcheshvan':'חשוון', 'Heshvan':'חשוון',
  'Kislev':'כסלו', 'Tevet':'טבת', 'Sh\'vat':'שבט', 'Shvat':'שבט', 'Shevat':'שבט',
  'Adar':'אדר', 'Adar I':"אדר_א'", 'Adar II':"אדר_ב'", 'Adar1':"אדר_א'", 'Adar2':"אדר_ב'"
};

// המרת מספר יום (1-30) לאותיות עבריות בגימטריה לפי מוסכמת Chabadpedia
// משתמש בגרש ASCII (') ובגרשיים ASCII (") — לא בתווים העבריים, כי כך זה ב-URL של Chabadpedia.
function hebrewDayLetters(d) {
  if (d < 1 || d > 30) return null;
  const ones = ['','א','ב','ג','ד','ה','ו','ז','ח','ט'];
  // מקרים מיוחדים: 15=ט"ו, 16=ט"ז (לא י"ה/י"ו, שמות הקדושים)
  if (d === 15) return 'ט"ו';
  if (d === 16) return 'ט"ז';
  if (d <= 9) return ones[d] + "'";
  if (d === 10) return "י'";
  if (d === 20) return "כ'";
  if (d === 30) return "ל'";
  if (d <= 19) return 'י"' + ones[d - 10];   // 11-14, 17-19
  /* d <= 29 */ return 'כ"' + ones[d - 20];   // 21-29
}

async function fetchHebrewDate() {
  const n = new Date();
  const url = `https://www.hebcal.com/converter?cfg=json&gy=${n.getFullYear()}&gm=${n.getMonth()+1}&gd=${n.getDate()}&g2h=1`;
  const json = await fetchJson(url);
  return { day: json.hd, month: json.hm, year: json.hy };
}

function buildChabadpediaUrl(day, monthEn) {
  const dayHe = hebrewDayLetters(day);
  const monthHe = HEB_MONTH_MAP[monthEn];
  if (!dayHe || !monthHe) return null;
  const title = `תבנית:היום_יום/${dayHe}_${monthHe}`;
  return `https://chabadpedia.co.il/index.php?title=${encodeURIComponent(title)}`;
}

// חילוץ תוכן תבנית: ה-HTML הוא MediaWiki רגיל. אנחנו רוצים את הטקסט שבתוך mw-parser-output
// אבל בלי תיבת ה"קטגוריות" שבסוף ובלי קישורי ניווט.
function extractChabadpediaContent(html) {
  // חפש את אזור התוכן הראשי של MediaWiki
  let m = html.match(/<div[^>]+class="[^"]*mw-parser-output[^"]*"[^>]*>([\s\S]*?)<\/div>\s*(?:<div[^>]+class="[^"]*(?:printfooter|catlinks)|<noscript|<!--)/i);
  let inner = m ? m[1] : null;
  if (!inner) {
    // גיבוי: לקח את כל גוף ה-content
    m = html.match(/<div[^>]+id="mw-content-text"[^>]*>([\s\S]*?)<\/div>\s*<\/div>/i);
    inner = m ? m[1] : null;
  }
  if (!inner) return null;

  // נקה תוויות עריכה, קישורים, ותגי HTML
  inner = inner
    .replace(/<span class="mw-editsection[\s\S]*?<\/span>/gi, '')
    .replace(/<table[^>]*class="[^"]*(?:metadata|navbox|infobox)[^>]*"[\s\S]*?<\/table>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '');

  // המר פסקאות לטקסט נקי
  let text = normalizeText(inner);
  if (!text || text.length < 30) return null;

  // ── ניקוי "פרטי עריכה" של MediaWiki שנשארו בטקסט ──
  // 1. חתוך ניווט "הקודם:" / "הבא:" / קישורים בין דפי תבנית
  const navPos = text.search(/(?:הקודם\s*[::]|הבא\s*[::]|תוכן\s+עניינים|◄|►)/);
  if (navPos > 30) text = text.substring(0, navPos);

  // 2. הסר template variables לא ממולאים מסוג {{{שם}}}
  text = text.replace(/\{\{\{[^}]+\}\}\}/g, '');
  // והסר גם תבניות {{...}} שנשארו
  text = text.replace(/\{\{[^}]+\}\}/g, '');

  // 3. תיקוני רווחים שנוצרו מתגי HTML שפיצלו את הטקסט:
  //    א. רווחים מיותרים לפני סימני פיסוק: "נגונים ," → "נגונים,"
  text = text.replace(/[ \t]+([,.!?;:׳״])/g, '$1');
  //    ב. ה' הידיעה שהופרדה ממילה: "ה צמח" → "הצמח", "ה רבי" → "הרבי"
  text = text.replace(/(^|[\s.,!?])ה[ \t]+([א-ת])/g, '$1ה$2');
  //    ג. רווחים אופקיים מרובים → אחד
  text = text.replace(/[ \t]+/g, ' ');
  //    ד. שורות ריקות מרובות → שורה ריקה אחת
  text = text.replace(/\n[ \t]*\n[\s\n]*/g, '\n\n');
  text = text.trim();

  // הגבל לאורך מתאים לקיוסק (פסקה/שתיים)
  if (text.length > 1200) {
    const cut = text.substring(0, 1200);
    const lastDot = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('? '), cut.lastIndexOf('! '), cut.lastIndexOf('.\n'));
    text = (lastDot > 600 ? cut.substring(0, lastDot+1) : cut).trim() + '…';
  }
  return text;
}

async function fetchHayomYomFromChabadpedia() {
  const hd = await fetchHebrewDate();
  if (!hd || !hd.day || !hd.month) throw new Error('לא הצליח לקבל תאריך עברי');
  const url = buildChabadpediaUrl(hd.day, hd.month);
  if (!url) throw new Error(`לא יכול לבנות URL ל-${hd.day} ${hd.month}`);
  const html = await fetchHtml(url);
  if (!html || html.length < 1000) throw new Error('דף Chabadpedia ריק או חסום');
  const text = extractChabadpediaContent(html);
  if (!text) throw new Error('לא נמצא תוכן בדף Chabadpedia');
  return { text, url, hebrewDate: `${hebrewDayLetters(hd.day)} ${HEB_MONTH_MAP[hd.month]||hd.month}` };
}
function setCORS(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function sendJSON(res, data, status=200) {
  setCORS(res);
  res.writeHead(status, {
    'Content-Type':'application/json; charset=utf-8',
    'Cache-Control':'no-store, no-cache, must-revalidate, max-age=0'
  });
  res.end(JSON.stringify(data));
}

function sendHTML(res, html) {
  setCORS(res);
  res.writeHead(200, {
    'Content-Type':'text/html; charset=utf-8',
    'Cache-Control':'no-store, no-cache, must-revalidate, max-age=0',
    'Pragma':'no-cache',
    'Expires':'0'
  });
  res.end(html);
}

// ── שרת ──
const server = http.createServer(async (req, res) => {
  const parsed = url.parse(req.url, true);
  const pathname = parsed.pathname;

  if (req.method === 'OPTIONS') { setCORS(res); res.writeHead(204); return res.end(); }

  // ── GET /api/data — מחזיר נתוני קיוסק ──
  if (req.method === 'GET' && pathname === '/api/data') {
    const data = loadData();
    // נקה רשומות "רק היום" שעבר זמנן (תאריך שונה מהיום) — חזרה אוטומטית למחרת
    if (data.hideToday && typeof data.hideToday === 'object') {
      const tk = todayKey();
      let changed = false;
      for (const k of Object.keys(data.hideToday)) {
        if (data.hideToday[k] !== tk) { delete data.hideToday[k]; changed = true; }
      }
      if (changed) { try { saveData(data); } catch(e){} }
    }
    // אם יש גרסת HD מקומית — העדף אותה. ההתאמה לפי מיקום ברשימה.
    const hdDir = path.join(__dirname, 'videos_HD');
    if (fs.existsSync(hdDir) && Array.isArray(data.playlist)) {
      data.playlist = data.playlist.map((v, i) => {
        const hdFile = `video_${i}_HD.mp4`;
        if (fs.existsSync(path.join(hdDir, hdFile))) {
          return { ...v, url: `/videos_HD/${hdFile}`, hd: true };
        }
        return v;
      });
    }
    data.buildVersion = BUILD_VERSION;
    return sendJSON(res, data);
  }

  // הגשת סרטוני HD מקומיים עם תמיכה ב-Range (לדילוג חלק)
  if (req.method === 'GET' && pathname.startsWith('/videos_HD/')) {
    const fileName = pathname.replace('/videos_HD/', '');
    if (/[\/\\]|\.\./.test(fileName)) { res.writeHead(403); return res.end(); }
    const filePath = path.join(__dirname, 'videos_HD', fileName);
    if (!fs.existsSync(filePath)) { res.writeHead(404); return res.end(); }
    const stat = fs.statSync(filePath);
    const range = req.headers.range;
    if (range) {
      const m = range.match(/bytes=(\d+)-(\d+)?/);
      const start = m ? parseInt(m[1]) : 0;
      const end = m && m[2] ? parseInt(m[2]) : stat.size - 1;
      res.writeHead(206, {
        'Content-Range': `bytes ${start}-${end}/${stat.size}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': end - start + 1,
        'Content-Type': 'video/mp4'
      });
      return fs.createReadStream(filePath, { start, end }).pipe(res);
    }
    res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': stat.size, 'Accept-Ranges': 'bytes' });
    return fs.createReadStream(filePath).pipe(res);
  }

  // ── POST /api/extract — חולץ MP4 מ-URL ──
  if (req.method === 'POST' && pathname === '/api/extract') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', async () => {
      try {
        const { pageUrl } = JSON.parse(body);
        if (!pageUrl || !pageUrl.includes('chabad.info')) {
          return sendJSON(res, {error:'נא להכניס לינק מ-chabad.info'}, 400);
        }
        const result = await fetchMP4fromChabadInfo(pageUrl);
        return sendJSON(res, result);
      } catch(e) {
        return sendJSON(res, {error: e.message}, 500);
      }
    });
    return;
  }

  // ── POST /api/save — שומר סרטון נבחר ──
  if (req.method === 'POST' && pathname === '/api/save') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const update = JSON.parse(body);
        const data = loadData();
        if (update.videoUrl !== undefined) data.videoUrl = update.videoUrl;
        if (update.videoTitle !== undefined) data.videoTitle = update.videoTitle;
        if (update.categoryUrl !== undefined) data.categoryUrl = update.categoryUrl;
        if (update.playlist !== undefined) data.playlist = update.playlist;
        if (update.prayers !== undefined) data.prayers = {...data.prayers, ...update.prayers};
        if (update.videoOffBeforePrayer !== undefined) data.videoOffBeforePrayer = !!update.videoOffBeforePrayer;
        if (update.birthdays !== undefined && Array.isArray(update.birthdays)) data.birthdays = update.birthdays;
        if (update.torah !== undefined) data.torah = update.torah;
        if (update.hayomYom !== undefined) { data.hayomYom = update.hayomYom; data.hayomYomDate = todayKey(); }
        if (update.items !== undefined) data.items = update.items;
        if (update.donors !== undefined && Array.isArray(update.donors)) data.donors = update.donors;
        if (update.candleEvents !== undefined) { data.candleEvents = update.candleEvents; data.candleEventsDate = todayKey(); }
        if (update.zmanimVisible !== undefined) data.zmanimVisible = {...(data.zmanimVisible||{}), ...update.zmanimVisible};
        if (update.learningVisible !== undefined) data.learningVisible = {...(data.learningVisible||{}), ...update.learningVisible};
        if (update.sectionsVisible !== undefined) data.sectionsVisible = {...(data.sectionsVisible||{}), ...update.sectionsVisible};
        if (update.hideToday !== undefined && update.hideToday && typeof update.hideToday === 'object') {
          data.hideToday = {...(data.hideToday||{}), ...update.hideToday};
          // נקה רשומות ריקות (כיבוי "רק היום")
          for (const k of Object.keys(data.hideToday)) {
            if (!data.hideToday[k]) delete data.hideToday[k];
          }
        }
        if (update.dailyLearningOverrides !== undefined) data.dailyLearningOverrides = {...(data.dailyLearningOverrides||{}), ...update.dailyLearningOverrides};
        if (update.haftarah !== undefined) data.haftarah = update.haftarah;
        if (update.pithgam !== undefined) data.pithgam = update.pithgam;
        if (update.viewingWindows !== undefined && Array.isArray(update.viewingWindows)) data.viewingWindows = update.viewingWindows;
        if (update.gallerySelected !== undefined) data.gallerySelected = update.gallerySelected;
        if (update.galleryCustom !== undefined) data.galleryCustom = update.galleryCustom;
        if (update.galleryInterval !== undefined) data.galleryInterval = update.galleryInterval;
        if (update.sponsorBox !== undefined) data.sponsorBox = {...(data.sponsorBox||{}), ...update.sponsorBox};
        if (update.sponsorDaily !== undefined) data.sponsorDaily = {...(data.sponsorDaily||{}), ...update.sponsorDaily};
        if (update.sponsorWeekly !== undefined) data.sponsorWeekly = {...(data.sponsorWeekly||{}), ...update.sponsorWeekly};
        if (update.sponsorScreen !== undefined) data.sponsorScreen = {...(data.sponsorScreen||{}), ...update.sponsorScreen};
        if (update.memorialBox !== undefined) data.memorialBox = {...(data.memorialBox||{}), ...update.memorialBox};
        saveData(data);
        return sendJSON(res, {ok:true});
      } catch(e) {
        return sendJSON(res, {error:e.message}, 500);
      }
    });
    return;
  }

  // ── POST /api/refresh-playlist — בונה רשימת וידאו מהקטגוריה ──
  if (req.method === 'POST' && pathname === '/api/refresh-playlist') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', async () => {
      try {
        const upd = body ? JSON.parse(body) : {};
        if (upd.categoryUrl) {
          const d = loadData();
          d.categoryUrl = upd.categoryUrl;
          saveData(d);
        }
        const count = await refreshPlaylist();
        const d2 = loadData();
        return sendJSON(res, { ok: true, count, playlist: d2.playlist });
      } catch(e) {
        return sendJSON(res, { error: e.message }, 500);
      }
    });
    return;
  }

  // ── POST /api/refresh-hayomyom — מושך את היום יום מ-chabad.org ──
  if (req.method === 'POST' && pathname === '/api/refresh-hayomyom') {
    const r = await refreshHayomYom();
    const d = loadData();
    return sendJSON(res, { ...r, hayomYom: d.hayomYom, hayomYomDate: d.hayomYomDate });
  }

  // ── GET /api/hayomyom-debug — מחזיר אבחון של שני המקורות ──
  if (req.method === 'GET' && pathname === '/api/hayomyom-debug') {
    const out = {};
    // Chabadpedia (מקור ראשי)
    try {
      const hd = await fetchHebrewDate();
      const url = buildChabadpediaUrl(hd.day, hd.month);
      const html = await fetchHtml(url);
      out.chabadpedia = {
        hebrewDate: `${hebrewDayLetters(hd.day)} ${HEB_MONTH_MAP[hd.month]||hd.month}`,
        url,
        htmlLength: html.length,
        title: (html.match(/<title>([^<]*)<\/title>/i) || [])[1] || null,
        extractedTextLen: (extractChabadpediaContent(html) || '').length,
        extractedPreview: (extractChabadpediaContent(html) || '').substring(0, 200)
      };
    } catch(e) { out.chabadpedia = { error: e.message }; }
    // chabad.org (גיבוי)
    try {
      const html = await fetchHtml(HAYOMYOM_URL);
      out.chabadOrg = {
        url: HAYOMYOM_URL,
        htmlLength: html.length,
        cloudflareBlocked: /Just a moment\.\.\./i.test(html),
        title: (html.match(/<title>([^<]*)<\/title>/i) || [])[1] || null
      };
    } catch(e) { out.chabadOrg = { error: e.message }; }
    return sendJSON(res, out);
  }

  // ── POST /api/refresh-zmanim — מושך זמנים מ-chabad.org RSS ──
  if (req.method === 'POST' && pathname === '/api/refresh-zmanim') {
    const r = await refreshZmanim();
    const d = loadData();
    return sendJSON(res, { ...r, zmanim: d.zmanim, zmanimDate: d.zmanimDate });
  }

  // ── POST /api/refresh-candle — מושך הדלקת נרות מ-chabad.org ICS ──
  if (req.method === 'POST' && pathname === '/api/refresh-candle') {
    const r = await refreshCandleLighting();
    const d = loadData();
    return sendJSON(res, { ...r, candleEvents: d.candleEvents, candleEventsDate: d.candleEventsDate });
  }

  // ── POST /api/refresh-learning — מושך לימוד יומי מ-chabad.org.il ──
  if (req.method === 'POST' && pathname === '/api/refresh-learning') {
    const r = await refreshDailyLearning();
    const d = loadData();
    return sendJSON(res, { ...r, dailyLearning: d.dailyLearning, dailyLearningDate: d.dailyLearningDate });
  }

  // ── GET /api/learning-debug — מציג מה מגיע מ-Sefaria ומה מחושב מקומית ──
  if (req.method === 'GET' && pathname === '/api/learning-debug') {
    const out = { source:'Sefaria API + תהילים מקומי', sefariaUrl: SEFARIA_CALENDARS_URL };
    try {
      const json = await fetchJson(SEFARIA_CALENDARS_URL);
      const items = json.calendar_items || [];
      out.sefariaDate = json.date;
      out.sefariaItems = items.map(it => ({
        titleHe: it.title && it.title.he,
        displayValueHe: it.displayValue && it.displayValue.he,
        category: it.category,
        mappedKey: SEFARIA_TITLE_MAP[(it.title && it.title.he) || ''] || null,
        hasAliyot: !!(it.extraDetails && it.extraDetails.aliyot)
      }));
    } catch(e) {
      out.sefariaError = e.message;
    }
    try {
      const day = await fetchHebrewDay();
      out.hebrewDay = day;
      out.tehillimToday = day ? `פרקים ${TEHILLIM_DAILY[Math.min(day-1,29)]}` : null;
    } catch(e) {
      out.hebrewDayError = e.message;
    }
    return sendJSON(res, out);
  }

  // ── GET /api/zmanim-rss-debug — מראה את 6 הפריטים הראשונים מה-RSS כדי לכוון את המיפוי ──
  if (req.method === 'GET' && pathname === '/api/zmanim-rss-debug') {
    try {
      const xml = await fetchHtml(ZMANIM_RSS_URL);
      const items = parseRssItems(xml).slice(0, 6);
      return sendJSON(res, { url: ZMANIM_RSS_URL, xmlLength: xml.length, first300: xml.substring(0, 300), itemCount: parseRssItems(xml).length, sample: items });
    } catch(e) {
      return sendJSON(res, { error: e.message }, 500);
    }
  }

  // ── GET /api/candle-debug — מציג 5 האירועים הראשונים מה-ICS לבדיקה ──
  if (req.method === 'GET' && pathname === '/api/candle-debug') {
    try {
      const ics = await fetchHtml(CANDLE_ICS_URL);
      const events = parseIcs(ics);
      const sample = events.slice(0, 5).map(e => ({
        summary: e.SUMMARY && e.SUMMARY.value,
        dtstart: e.DTSTART && { value: e.DTSTART.value, params: e.DTSTART.params },
        dtend: e.DTEND && { value: e.DTEND.value, params: e.DTEND.params },
        iso: icsDateToIso(e.DTSTART),
        type: classifyCandle((e.SUMMARY && e.SUMMARY.value) || '')
      }));
      return sendJSON(res, { url: CANDLE_ICS_URL, icsLength: ics.length, first300: ics.substring(0, 300), eventCount: events.length, sample });
    } catch(e) {
      return sendJSON(res, { error: e.message }, 500);
    }
  }

  // ── GET /admin — ממשק ניהול ──
  if (req.method === 'GET' && (pathname === '/admin' || pathname === '/admin/')) {
    try {
      const html = fs.readFileSync(path.join(__dirname, 'admin.html'), 'utf8');
      return sendHTML(res, html);
    } catch(e) {
      res.writeHead(500, {'Content-Type':'text/plain; charset=utf-8'});
      return res.end('admin.html לא נמצא ליד server.cjs');
    }
  }

  // ── GET /kiosk — מסך התצוגה עצמו (אותו origin כמו האדמין) ──
  if (req.method === 'GET' && (pathname === '/kiosk' || pathname === '/kiosk/' || pathname === '/kiosk.html')) {
    try {
      const html = fs.readFileSync(path.join(__dirname, 'kiosk.html'), 'utf8');
      return sendHTML(res, html);
    } catch (e) {
      res.writeHead(500, {'Content-Type':'text/plain; charset=utf-8'});
      return res.end('kiosk.html לא נמצא ליד server.cjs');
    }
  }

  // ── GET / — הפנייה לאדמין ──
  if (req.method === 'GET' && pathname === '/') {
    res.writeHead(302, {Location:'/admin'});
    return res.end();
  }

  res.writeHead(404); res.end('Not found');
});

// הפעל את השרת רק כשמריצים ישירות (node server.cjs)
if (require.main === module) {
  initFirestore().then(() => loadDataAsync()).then(() => {
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`\n✦ שרת קיוסק חב"ד פעיל`);
    console.log(`  מסך התצוגה: http://localhost:${PORT}/kiosk`);
    console.log(`  ממשק ניהול: http://localhost:${PORT}/admin`);
    console.log(`  מהפלאפון:   http://[IP-המחשב]:${PORT}/admin\n`);
    // בנה רשימת וידאו בעת ההפעלה (אם היא ריקה)
    const d = loadData();
    if (!d.playlist || d.playlist.length === 0) {
      console.log('  ⏳ טוען סרטונים מהקטגוריה...');
      refreshPlaylist();
    }
    // משוך את היום יום אם לא עודכן היום, או אם הערך השמור פגום (למשל דף חסימה ישן)
    if (d.hayomYomDate !== todayKey() || !isValidHayomYom(d.hayomYom)) {
      console.log('  ⏳ טוען "היום יום" (קובץ מקומי)...');
      refreshHayomYom();
    }
    // משוך זמנים אם לא עודכנו היום, או אם גרסת הסכימה ישנה (תיקון אזור-זמן)
    if (d.zmanimDate !== todayKey() || !d.zmanim || !Object.keys(d.zmanim||{}).length || d.zmanimVersion !== ZMANIM_SCHEMA_VERSION) {
      console.log('  ⏳ טוען זמנים מ-chabad.org RSS...');
      refreshZmanim();
    }
    // משוך הדלקת נרות אם לא עודכן היום
    if (d.candleEventsDate !== todayKey() || !Array.isArray(d.candleEvents) || !d.candleEvents.length) {
      console.log('  ⏳ טוען לוח הדלקת נרות מ-chabad.org ICS...');
      refreshCandleLighting();
    }
    // משוך לימוד יומי אם לא עודכן היום, או אם הנתונים הישנים נכשלו (פחות מ-4 הצלחות), או אם חסר ספר המצוות
    {
      const dl = d.dailyLearning || {};
      const dlOk = Object.values(dl).filter(x => x && x.ref).length;
      const missingMitzvot = !(dl.mitzvot && dl.mitzvot.ref);
      if (d.dailyLearningDate !== todayKey() || dlOk < 4 || missingMitzvot) {
        console.log('  ⏳ טוען לימוד יומי מ-Sefaria...');
        refreshDailyLearning();
      }
    }
  });

  // רענון יומי ב-6:00 בבוקר שעון ישראל
  scheduleDaily6am(refreshHayomYom,       '"היום יום"');
  scheduleDaily6am(refreshZmanim,         'זמנים');
  scheduleDaily6am(refreshDailyLearning,  'לימוד יומי');
  scheduleDaily6am(refreshCandleLighting, 'הדלקת נרות');
  scheduleDaily6am(refreshPlaylist,       'סרטונים');
  });
}

// ── ייצוא פונקציות לבדיקה בלבד (לא משפיע על הרצה רגילה) ──
if (require.main !== module) module.exports = { extractVideoLinks, extractMP4, extractTitle, decodeEntities, fetchHtml, buildPlaylist, parseRssItems, parseIcs, icsDateToIso, classifyCandle, hhmmToIso };

