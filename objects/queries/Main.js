import getArabicQuery from './Arabic.js';
import getEnglishQuery from './English.js';
import getFrenchQuery from './French.js';
import getGermanQuery from './German.js';
import getHindiQuery from './Hindi.js';
import getJapaneseQuery from './Japanese.js';
import getMandarinQuery from './Mandarin.js';
import getPortugueseQuery from './Portuguese.js';
import getRussianQuery from './Russian.js';
import getSpanishQuery from './Spanish.js';

const languageTranslations = {
  English: {
    English: 'English',
    Mandarin: 'Mandarin',
    Spanish: 'Spanish',
    Hindi: 'Hindi',
    French: 'French',
    German: 'German',
    Japanese: 'Japanese',
    Russian: 'Russian',
    Portuguese: 'Portuguese',
    Arabic: 'Arabic',
  },
  Mandarin: {
    English: '英语',
    Mandarin: '普通话',
    Spanish: '西班牙语',
    Hindi: '印地语',
    French: '法语',
    German: '德语',
    Japanese: '日语',
    Russian: '俄语',
    Portuguese: '葡萄牙语',
    Arabic: '阿拉伯语',
  },
  Spanish: {
    English: 'Inglés',
    Mandarin: 'Mandarín',
    Spanish: 'Español',
    Hindi: 'Hindi',
    French: 'Francés',
    German: 'Alemán',
    Japanese: 'Japonés',
    Russian: 'Ruso',
    Portuguese: 'Portugués',
    Arabic: 'Árabe',
  },
  Hindi: {
    English: 'अंग्रेज़ी',
    Mandarin: 'मंदारिन',
    Spanish: 'स्पैनिश',
    Hindi: 'हिन्दी',
    French: 'फ्रेंच',
    German: 'जर्मन',
    Japanese: 'जापानी',
    Russian: 'रूसी',
    Portuguese: 'पुर्तगाली',
    Arabic: 'अरबी',
  },
  French: {
    English: 'Anglais',
    Mandarin: 'Mandarin',
    Spanish: 'Espagnol',
    Hindi: 'Hindi',
    French: 'Français',
    German: 'Allemand',
    Japanese: 'Japonais',
    Russian: 'Russe',
    Portuguese: 'Portugais',
    Arabic: 'Arabe',
  },
  German: {
    English: 'Englisch',
    Mandarin: 'Mandarin',
    Spanish: 'Spanisch',
    Hindi: 'Hindi',
    French: 'Französisch',
    German: 'Deutsch',
    Japanese: 'Japanisch',
    Russian: 'Russisch',
    Portuguese: 'Portugiesisch',
    Arabic: 'Arabisch',
  },
  Japanese: {
    English: '英語',
    Mandarin: '中国語',
    Spanish: 'スペイン語',
    Hindi: 'ヒンディー語',
    French: 'フランス語',
    German: 'ドイツ語',
    Japanese: '日本語',
    Russian: 'ロシア語',
    Portuguese: 'ポルトガル語',
    Arabic: 'アラビア語',
  },
  Russian: {
    English: 'Английский',
    Mandarin: 'Мандарин',
    Spanish: 'Испанский',
    Hindi: 'Хинди',
    French: 'Французский',
    German: 'Немецкий',
    Japanese: 'Японский',
    Russian: 'Русский',
    Portuguese: 'Португальский',
    Arabic: 'Арабский',
  },
  Portuguese: {
    English: 'Inglês',
    Mandarin: 'Mandarim',
    Spanish: 'Espanhol',
    Hindi: 'Hindi',
    French: 'Francês',
    German: 'Alemão',
    Japanese: 'Japonês',
    Russian: 'Russo',
    Portuguese: 'Português',
    Arabic: 'Árabe',
  },
  Arabic: {
    English: 'الإنجليزية',
    Mandarin: 'الصينية الماندارينية',
    Spanish: 'الإسبانية',
    Hindi: 'الهندية',
    French: 'الفرنسية',
    German: 'الألمانية',
    Japanese: 'اليابانية',
    Russian: 'الروسية',
    Portuguese: 'البرتغالية',
    Arabic: 'العربية',
  },
};

const setData = (data) => {
  data.source = languageTranslations[data.destination][data.source];
  data.destination = languageTranslations[data.destination][data.destination];
};

export default (data) => {
  if (data.destination === 'Arabic') {
    setData(data);

    return getArabicQuery(data);
  }

  if (data.destination === 'English') {
    setData(data);

    return getEnglishQuery(data);
  }

  if (data.destination === 'French') {
    setData(data);

    return getFrenchQuery(data);
  }

  if (data.destination === 'German') {
    setData(data);

    return getGermanQuery(data);
  }

  if (data.destination === 'Hindi') {
    setData(data);

    return getHindiQuery(data);
  }

  if (data.destination === 'Japanese') {
    setData(data);

    return getJapaneseQuery(data);
  }

  if (data.destination === 'Mandarin') {
    setData(data);

    return getMandarinQuery(data);
  }

  if (data.destination === 'Portuguese') {
    setData(data);

    return getPortugueseQuery(data);
  }

  if (data.destination === 'Russian') {
    setData(data);

    return getRussianQuery(data);
  }

  if (data.destination === 'Spanish') {
    setData(data);

    return getSpanishQuery(data);
  }

  return undefined;
};
