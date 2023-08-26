import _ from 'lodash';

import { franc } from 'franc';

import langid from 'langid';
import LangDetect from 'langdetect';
import LanguageDetect from 'languagedetect';

function detectLanguageFranc(text) {
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
}

function detectLanguageLanguagedetect(text) {
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
}

function detectLanguageLangid(text) {
  return new Promise((resolve) => {
    langid.identify(text, (err, lang) => {
      if (err) {
        resolve(undefined);
      } else {
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
        resolve(languagesMap[lang]);
      }
    });
  });
}

function detectLanguageLangDetect(text) {
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
}

function detectLanguageConsolidated(text) {
  const results = [];

  results.push(detectLanguageFranc(text));
  results.push(detectLanguageLanguagedetect(text));
  results.push(detectLanguageLangDetect(text));

  if (_.isEmpty(results)) return undefined;

  const counts = results.reduce((acc, val) => {
    if (val) {
      acc[val] = (acc[val] || 0) + 1;
    }
    return acc;
  }, {});

  if (_.isEmpty(counts)) return undefined;

  return Object.keys(counts).reduce((a, b) => (counts[a] > counts[b] ? a : b));
}

export {
  detectLanguageFranc,
  detectLanguageLanguagedetect,
  detectLanguageLangDetect,
  detectLanguageConsolidated,
};
