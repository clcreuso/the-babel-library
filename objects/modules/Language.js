import _ from 'lodash';

import LangDetect from 'langdetect';
import LanguageDetect from 'languagedetect';

import { franc } from 'franc';

const detectLanguageFranc = (text) => {
  const detected = franc(text);

  const languagesMap = {
    eng: 'English',
    cmn: 'Mandarin',
    spa: 'Spanish',
    hin: 'Hindi',
    fra: 'French',
    deu: 'German',
    jpn: 'Japanese',
    rus: 'Russian',
    por: 'Portuguese',
    ara: 'Arabic',
    zsm: 'Malay',
  };

  return languagesMap[detected];
};

const detectLanguageLanguagedetect = (text) => {
  const lngDetector = new LanguageDetect();
  const detected = lngDetector.detect(text, 1);

  if (detected && detected.length) {
    const language = detected[0][0];

    const languagesMap = {
      english: 'English',
      mandarin: 'Mandarin',
      spanish: 'Spanish',
      hindi: 'Hindi',
      french: 'French',
      german: 'German',
      japanese: 'Japanese',
      russian: 'Russian',
      portuguese: 'Portuguese',
      arabic: 'Arabic',
      malay: 'Malay',
    };

    return languagesMap[language.toLowerCase()];
  }

  return undefined;
};

const detectLanguageLangDetect = (text) => {
  const detected = LangDetect.detect(text);

  if (detected && detected.length) {
    const language = detected[0].lang;

    const languagesMap = {
      en: 'English',
      zh: 'Mandarin',
      es: 'Spanish',
      hi: 'Hindi',
      fr: 'French',
      de: 'German',
      ja: 'Japanese',
      ru: 'Russian',
      pt: 'Portuguese',
      ar: 'Arabic',
      ms: 'Malay',
    };

    return languagesMap[language];
  }

  return undefined;
};

const detectFrenchAccent = (text) => {
  const regex = /[éèêàâôçÉÈÊÀÂÔÇ]/g;

  return regex.test(text);
};

const detectLanguage = async (text) => {
  const results = [];

  if (detectFrenchAccent(text)) return 'French';

  results.push(detectLanguageFranc(text));
  results.push(detectLanguageLangDetect(text));
  results.push(detectLanguageLanguagedetect(text));

  if (_.isEmpty(results)) return undefined;

  const counts = results.reduce((acc, val) => {
    if (val) acc[val] = (acc[val] || 0) + 1;

    return acc;
  }, {});

  if (_.isEmpty(counts)) return undefined;

  return Object.keys(counts).reduce((a, b) => (counts[a] > counts[b] ? a : b));
};

export default detectLanguage;
