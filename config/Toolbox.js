import fs from 'fs';
import util from 'util';
import crypto from 'crypto';
import iso6391 from 'iso-639-1';

class Toolbox {
  /** **********************************************************************************************
   **                                           Helpers                                           **
   ********************************************************************************************** */

  sleep(time) {
    return new Promise((res) => setTimeout(() => res(), time));
  }

  getIsoCode(language) {
    const code = iso6391.getCode(language);

    return code ? code.toLowerCase() : null;
  }

  hasText(text) {
    if (text === undefined) return false;

    return !/^[^\p{L}]*$/u.test(text);
  }

  countWords(text) {
    if (text === '') return 0;

    const words = text.split(/[\s,.-]+/);

    return words.filter((word) => this.hasText(word)).length;
  }

  writeFullObject(object) {
    return util.inspect(object, { showHidden: false, depth: null, colors: true });
  }

  /** **********************************************************************************************
   **                                        Helpers: Time                                        **
   ********************************************************************************************** */

  now(ms = true) {
    const date = Date.now();

    return ms ? date : Math.round(date / 1000);
  }

  seconds(seconds, ms = true) {
    return Math.round(ms ? 1000 * seconds : seconds);
  }

  minutes(minutes, ms = true) {
    minutes *= 60;

    return Math.round(ms ? 1000 * minutes : minutes);
  }

  hours(hours, ms = true) {
    hours *= 60 * 60;

    return Math.round(ms ? 1000 * hours : hours);
  }

  days(days, ms = true) {
    days *= 60 * 60 * 24;

    return Math.round(ms ? 1000 * days : days);
  }

  months(months, ms = true) {
    months *= 60 * 60 * 24 * 30;

    return Math.round(ms ? 1000 * months : months);
  }

  /** **********************************************************************************************
   **                                        Helpers: Hash                                        **
   ********************************************************************************************** */

  getFileHash(path) {
    return crypto.createHash('md5').update(fs.readFileSync(path)).digest('hex');
  }

  getObjectHash(object) {
    return crypto.createHash('md5').update(JSON.stringify(object)).digest('hex');
  }
}

export default new Toolbox();
