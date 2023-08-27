import _ from 'lodash';
import fs from 'fs';
import EPUB from 'epub';
import zip from 'archiver';
import dotenv from 'dotenv';
import prompt from 'prompt';
import mime from 'mime-types';
import iso6391 from 'iso-639-1';
import inquirer from 'inquirer';

import { jsonrepair } from 'jsonrepair';
import { EventEmitter } from 'events';
import { isWithinTokenLimit } from 'gpt-tokenizer';
import { createCanvas, loadImage } from 'canvas';
import { Configuration, OpenAIApi } from 'openai';

import detectLanguage from '../modules/Language.js';

import Database from '../Database.js';

import getContext from '../queries/Main.js';

import Logger from '../../config/logger.js';
import Toolbox from '../../config/Toolbox.js';

dotenv.config();

const OpenAI = new OpenAIApi(
  new Configuration({ organization: process.env.OPEN_AI_ORG, apiKey: process.env.OPEN_AI_KEY })
);

const MAX_TOKENS = 500;

export default class EpubInterface extends EventEmitter {
  constructor(params) {
    super();

    this.params = {
      user: params.user || 'Toto',
      source: params.source || 'English',
      destination: params.destination || 'French',
      model: params.model || 'gpt-3.5-turbo-0613',
    };

    this.metadata = params.metadata || {};

    this.timers = {
      queries: { id: null, interval: 500 },
    };

    this.setFile(params.path);
  }

  /** **********************************************************************************************
   **                                           Getters                                           **
   ********************************************************************************************** */

  getInfos() {
    return `EPUB (${this.getEpubName()})`;
  }

  getQuery() {
    return _.find(this.queries, (query) => !query.finish && !query.waiting);
  }

  getIsoCode(language) {
    const code = iso6391.getCode(language);

    return code ? code.toLowerCase() : null;
  }

  getStatus() {
    return `${this.getInfos()} - STATUS ${_.filter(this.queries, (query) => query.finish).length}/${
      this.queries.length
    }`;
  }

  getCover() {
    return _.find(this.epub.manifest, (el) => {
      if (!el['media-type'].includes('image')) return false;

      return _.some(Object.values(el), (value) => {
        if (typeof value !== 'string') return false;

        return value.toLowerCase().includes('cover');
      });
    });
  }

  getEpubName() {
    const iso = Toolbox.getIsoCode(this.params.destination);

    const { title, subtitle, creator } = this.metadata;

    if (title && subtitle && creator) return `${title} - ${subtitle} | ${creator} (${iso})`;

    if (title && creator) return `${title} | ${creator} (${iso})`;

    return `${title} (${iso})`;
  }

  getEpubPath() {
    return `./library/${this.getEpubName()}.epub`;
  }

  /** **********************************************************************************************
   **                                           Setters                                           **
   ********************************************************************************************** */

  setCover(cover) {
    this.metadata.cover_id = cover.id;
    this.metadata.cover_path = cover.href;
  }

  setFile(path) {
    this.file = {};

    this.file.path = path;
    this.file.hash = Toolbox.getFileHash(path);
    this.file.folder = `./tmp/${this.file.hash}`;
  }

  /** **********************************************************************************************
   **                                           Helpers                                           **
   ********************************************************************************************** */

  isOPF(path) {
    return path.endsWith('.opf');
  }

  isCover(path) {
    return path.endsWith(this.metadata.cover_path);
  }

  isHTML(path) {
    return path.endsWith('.htm') || path.endsWith('.html') || path.endsWith('.xhtml');
  }

  isUselessTag(tag) {
    return ['b', 'i', 'em', 'strong', 'small', 'mark', 'del', 'ins', 'u', 's', 'span'].includes(
      tag
    );
  }

  hasFullyQuery(data) {
    return !isWithinTokenLimit(data, MAX_TOKENS);
  }

  hasFinishTranslation() {
    return this.queries.every((query) => query.finish);
  }

  readFile(path) {
    return fs.readFileSync(path).toString('utf8');
  }

  writeFile(path, content) {
    fs.writeFileSync(path, content, { encoding: 'utf8' });
  }

  /** **********************************************************************************************
   **                                        Helpers: HTML                                        **
   ********************************************************************************************** */

  replaceHtmlQuote(html) {
    return html.replace(/>([^<]+)</g, (match, content) => {
      content = content.replace(/("|"|“|”|《|》|«|»|‹|›|〈|〉|｢|｣|<<|>>)/g, "'");
      content = content.replace(/(^|\s)’|‘(\s|$)/g, "$1'$2");
      content = content.replace(/(^|\s)‘|’(\s|$)/g, "$1'$2");

      return `>${content}<`;
    });
  }

  removeXmlTags(html) {
    return html.replace(/<\?(?!xml)[^>]+?\?>/g, (match) => {
      Logger.debug(`${this.getInfos()} - DELETE_XML_TAG`, match);

      return '';
    });
  }

  removeHtmlTags(html, regex, type) {
    return html.replace(regex, (match, tag) => {
      if (!this.isUselessTag(tag)) return match;

      const texts = match.match(/(?<=>)(?!>)(.*?)(?=<)/g);

      if (!_.every(texts, (el) => Toolbox.hasText(el))) return match;

      // Logger.debug(`${this.getInfos()} - REPLACE_HTML_TAG`, {
      //   match,
      //   tag,
      //   replace: texts.join(''),
      // });

      return type === 'prefix' ? `>${texts.join('')}` : `${texts.join('')}<`;
    });
  }

  readHTML(path) {
    let html = this.readFile(path);

    html = this.removeXmlTags(html);
    html = this.replaceHtmlQuote(html);

    _.times(5, () => {
      html = this.removeHtmlTags(html, />[^<]*[a-z][^>]*<(\w+)[^>]*>[a-zA-Z\s]+<\/\1>/g, 'prefix');
      html = this.removeHtmlTags(html, /<(\w+)[^>]*>[a-zA-Z\s]+<\/\1>[^<]*[a-z][^>]*</g, 'suffix');
    });

    return html;
  }

  /** **********************************************************************************************
   **                                         Write: OPF                                          **
   ********************************************************************************************** */

  getMetadataTitle() {
    const title = this.metadata.title || this.epub.metadata.title;

    return title
      ? `<dc:title id="t1">${title}</dc:title>
    <meta property="title-type" refines="#t1">main</meta>
    <meta property="display-seq" refines="#t1">1</meta>`
      : ``;
  }

  getMetadataSubtitle() {
    const { subtitle } = this.metadata;

    return subtitle
      ? `<dc:title id="t2">${subtitle}</dc:title>
    <meta property="title-type" refines="#t2">subtitle</meta>
    <meta property="display-seq" refines="#t2">1</meta>`
      : ``;
  }

  getMetadataCreator() {
    const creator = this.metadata.creator || this.epub.metadata.creator;

    return creator ? `<dc:creator>${creator}</dc:creator>` : ``;
  }

  getMetadataDate() {
    const { date } = this.epub.metadata;

    return date ? `<dc:date>${date}</dc:date>` : ``;
  }

  getMetadataPublisher() {
    const { publisher } = this.epub.metadata || 'The Babel Library';

    return publisher ? `<dc:publisher>${publisher}</dc:publisher>` : ``;
  }

  getMetadataLanguage() {
    const iso = this.getIsoCode(this.params.destination);

    return iso ? `<dc:language>${iso}</dc:language>` : ``;
  }

  getMetadataSerie() {
    const { series_name } = this.metadata;

    return series_name ? `<meta name="calibre:series" content="${series_name}"/>` : ``;
  }

  getMetadataSeriesIndex() {
    const { series_volume } = this.metadata;

    return series_volume ? `<meta name="calibre:series_index" content="${series_volume}"/>` : ``;
  }

  getMetadataCover() {
    return this.metadata.cover_id ? `<meta name="cover" content="${this.metadata.cover_id}"/>` : ``;
  }

  getMetadata() {
    return [
      this.getMetadataTitle(),
      this.getMetadataSubtitle(),
      this.getMetadataCreator(),
      this.getMetadataDate(),
      this.getMetadataPublisher(),
      this.getMetadataLanguage(),
      this.getMetadataSerie(),
      this.getMetadataSeriesIndex(),
      this.getMetadataCover(),
    ].join('');
  }

  writeOPF(path) {
    let content = this.readFile(path);

    content = content.replace(
      /(<metadata\b[^>]*>)([\s\S]*?)(<\/metadata>)/,
      `$1${this.getMetadata()}$3`
    );

    content = content.replace(/&(?!amp;)/g, '&amp;');

    this.writeFile(path, content);
  }

  /** **********************************************************************************************
   **                                        Write: Cover                                         **
   ********************************************************************************************** */

  async writeCover(path) {
    const image = await loadImage(path);

    const canvas = createCanvas(800, 1280);
    const context = canvas.getContext('2d');

    context.drawImage(image, 0, 0, 800, 1280);

    context.beginPath();
    context.moveTo(0, 0);
    context.lineTo(0, 90);
    context.lineTo(275, 90);
    context.lineTo(350, 0);
    context.closePath();

    context.lineWidth = 8;
    context.strokeStyle = '#a20000';
    context.stroke();

    context.fillStyle = '#fff9b8';
    context.fill();

    context.fillStyle = '#16180f';
    context.textAlign = 'center';
    context.font = '34px "Times New Roman"';
    context.fillText('The Babel Library', 160, 45);
    context.font = '20px "Times New Roman"';
    context.fillText(`Translated from "${this.params.source}"`, 142, 70);

    const buffer = canvas.toBuffer(mime.lookup(path));

    fs.writeFileSync(path, buffer);
  }

  /** **********************************************************************************************
   **                                            Write                                            **
   ********************************************************************************************** */

  translateFile(path, translations) {
    const origins = this.files[path].tokens;

    return Object.keys(translations).reduce((file, uuid) => {
      if (typeof origins[uuid] !== 'string' || typeof translations[uuid] !== 'string') return file;

      let translation = translations[uuid].replace(/&(?!amp;)/g, '&amp;');

      if (origins[uuid].startsWith(' ') && !translation.startsWith(' ')) {
        translation = ` ${translation}`;
      }

      if (origins[uuid].endsWith(' ') && !translation.endsWith(' ')) {
        translation = `${translation} `;
      }

      return file.replace(`>${origins[uuid]}<`, `>${translation}<`);
    }, this.readHTML(path));
  }

  writeEPUB() {
    const output = fs.createWriteStream(this.getEpubPath());
    const archive = zip('zip', { store: false });

    archive.on('error', (archiveErr) => {
      throw archiveErr;
    });

    archive.pipe(output);

    output.on('close', () => {
      Logger.info(`${this.getInfos()} - WRITE_EPUB "${this.getEpubPath()}"`);

      this.emit('writed');
    });

    this.file.paths.forEach((path) => {
      archive.append(fs.readFileSync(path), {
        name: path.replace(`${this.file.folder}/`, ''),
      });
    });

    archive.finalize();
  }

  write() {
    Object.entries(Database.translations).forEach(([path, translations]) => {
      if (!path.startsWith(this.file.folder) || !this.files[path]) return;

      const file = this.translateFile(path, translations);

      this.writeFile(path, file);

      Logger.info(`${this.getInfos()} - WRITE_FILE "${path}"`);
    });

    this.writeEPUB();
  }

  /** **********************************************************************************************
   **                                   Translate: Validations                                    **
   ********************************************************************************************** */

  invalidTranslation(data) {
    Logger.warn(`${this.getInfos()} - INVALID_TRANSLATION`, data);

    return false;
  }

  getValidationCounts(translation, origin, type) {
    const oCount = type === 'words' ? Toolbox.countWords(origin) : origin.length;
    const tCount = type === 'words' ? Toolbox.countWords(translation) : translation.length;

    const ratio = Database.getRatio(oCount, type);

    return {
      origin: oCount,
      translation: Math.round(tCount * ratio),
      ratio,
    };
  }

  getValidationTriggerLanguage(path, uuid, type) {
    this.triggers ||= {};
    this.triggers[path] ||= {};
    this.triggers[path][uuid] ||= {};

    this.triggers[path][uuid][type] ||= 0;
    this.triggers[path][uuid][type] += 1;

    return this.triggers[path][uuid][type];
  }

  getValidationTriggerLength(path, uuid, type) {
    this.triggers ||= {};
    this.triggers[path] ||= {};
    this.triggers[path][uuid] ||= {};

    if (!this.triggers[path][uuid][type]) {
      this.triggers[path][uuid][type] = 1.25;
    } else if (this.triggers[path][uuid][type] === 1.25) {
      this.triggers[path][uuid][type] = 1.5;
    } else if (this.triggers[path][uuid][type] === 1.5) {
      this.triggers[path][uuid][type] = 2;
    } else if (this.triggers[path][uuid][type] === 2) {
      this.triggers[path][uuid][type] = 3;
    } else if (this.triggers[path][uuid][type] === 3) {
      this.triggers[path][uuid][type] = 5;
    } else if (this.triggers[path][uuid][type] === 5) {
      this.triggers[path][uuid][type] = 10;
    }

    return this.triggers[path][uuid][type];
  }

  async isValidTranslationLanguage(text, file, uuid) {
    const textLanguage = await detectLanguage(text);

    if (this.params.destination === textLanguage) return true;

    const trigger = this.getValidationTriggerLanguage(file, uuid, 'lang');

    return trigger < 5
      ? this.invalidTranslation({ from: 'lang', text, textLanguage, trigger })
      : true;
  }

  isValidTranslationLength(translation, origin, file, uuid, type) {
    const trigger = this.getValidationTriggerLength(file, uuid, type);

    const counts = this.getValidationCounts(translation, origin, type);

    if (counts.translation < counts.origin / trigger) {
      return this.invalidTranslation({ from: `${type}_1`, origin, translation, counts, trigger });
    }

    if (counts.origin < counts.translation / trigger) {
      return this.invalidTranslation({ from: `${type}_2`, origin, translation, counts, trigger });
    }

    Database.manageRatio(counts.origin, counts.translation, type);

    return true;
  }

  async isValidTranslation(translation, origin, file, uuid) {
    if (translation.includes('\\"uuid-')) return false;

    const vChars = this.isValidTranslationLength(translation, origin, file, uuid, 'chars');
    const vWords = this.isValidTranslationLength(translation, origin, file, uuid, 'words');
    const vLang = await this.isValidTranslationLanguage(translation, file, uuid);

    return vChars && vWords && vLang;
  }

  /** **********************************************************************************************
   **                                     Translate: Request                                      **
   ********************************************************************************************** */

  secureJsonParseJSON(str) {
    try {
      return JSON.parse(str.slice(str.indexOf('{'), str.lastIndexOf('}') + 1));
    } catch (error) {
      return undefined;
    }
  }

  parseTranslationJSON(data) {
    return (
      this.secureJsonParseJSON(data.choices[0].message.content) ||
      this.secureJsonParseJSON(jsonrepair(data.choices[0].message.content))
    );
  }

  parseTranslationRequest(data, query) {
    const translations = this.parseTranslationJSON(data);

    if (translations) {
      Object.keys(translations).forEach((file) => {
        if (!this.files[file] || !query.data[file]) return;

        Object.entries(translations[file]).forEach(async ([uuid, translation]) => {
          if (!this.files[file].tokens[uuid] || !query.data?.[file]?.[uuid]) return;

          if (!(await this.isValidTranslation(translation, query.data[file][uuid], file, uuid)))
            return;

          Database.setTranslation(file, uuid, translation);

          delete query.data?.[file]?.[uuid];
        });

        if (_.isEmpty(query.data[file])) delete query.data[file];
      });

      if (_.isEmpty(query.data)) query.finish = true;

      Logger.info(`${this.getInfos()} - PARSE_TRANSLATION_REQUEST ${query.id}`);
    } else {
      Logger.error(`${this.getInfos()} - PARSE_TRANSLATION_REQUEST ${query.id}`);
    }
  }

  getTranslationParams(query) {
    return {
      model: this.params.model,
      messages: [
        {
          role: 'user',
          content: getContext({
            source: this.params.source,
            destination: this.params.destination,
            book_title: this.epub.metadata.title,
            book_author: this.epub.metadata.creator,
            content: query.data,
          }),
        },
      ],
    };
  }

  sendTranslationRequest(query = this.getQuery()) {
    if (!query) return;

    query.waiting = true;

    OpenAI.createChatCompletion(this.getTranslationParams(query))
      .then((response) => this.parseTranslationRequest(response.data, query))
      .catch((err) =>
        Logger.error(
          `${this.getInfos()} - SEND_TRANSLATION_REQUEST ${query.id}`,
          err.response?.data || err
        )
      )
      .finally(() => {
        query.waiting = false;
      });

    Logger.info(`${this.getInfos()} - SEND_TRANSLATION_REQUEST ${query.id}`);
  }

  /** **********************************************************************************************
   **                                          Translate                                          **
   ********************************************************************************************** */

  onTranslateInterval() {
    this.sendTranslationRequest();

    if (!this.hasFinishTranslation()) return;

    this.emit('translated');

    this.stopTranslateInterval();
  }

  stopTranslateInterval() {
    clearInterval(this.timers.queries.id);

    this.timers.queries.id = null;
  }

  startTranslateInterval() {
    let index = 0;
    this.stopTranslateInterval();

    this.timers.queries.id = setInterval(() => {
      index += 1;

      if (index % 100) {
        this.onTranslateInterval();
      } else {
        this.parseQueries();
      }
    }, this.timers.queries.interval);

    Logger.info(`${this.getInfos()} - START_TRANSLATE_INTERVAL`);
  }

  translate() {
    this.startTranslateInterval();
  }

  /** **********************************************************************************************
   **                                       Parse: Queries                                        **
   ********************************************************************************************** */

  parseQueries() {
    let id = 0;

    this.queries = [];

    Object.keys(this.files).forEach((path) => {
      Object.entries(this.files[path].tokens).forEach(([uuid, text]) => {
        if (Database.hasTranslation(path, uuid)) return;

        if (this.queries[id] && this.hasFullyQuery(text)) id += 1;

        this.queries[id] ||= { id, finish: false, waiting: false, data: {} };

        this.queries[id].data[path] ||= {};
        this.queries[id].data[path][uuid] = text;

        if (this.hasFullyQuery(JSON.stringify(this.queries[id].data))) id += 1;
      });
    });

    Logger.info(`${this.getInfos()} - PARSE_QUERIES`);
  }

  /** **********************************************************************************************
   **                                         Parse: HTML                                         **
   ********************************************************************************************** */

  manageUUID(path) {
    this.files[path].elements += 1;

    return `uuid-${this.files[path].elements}`;
  }

  manageText(path, uuid) {
    if (Toolbox.hasText(this.files[path].tokens[uuid])) return;

    delete this.files[path].tokens[uuid];
  }

  manageTag(html, index) {
    if (html.slice(index, index + 4) === '<pre') {
      return html.indexOf('</pre>', index);
    }

    if (html.slice(index, index + 5) === '<code') {
      return html.indexOf('</code>', index);
    }

    if (html.slice(index, index + 6) === '<style') {
      return html.indexOf('</style>', index);
    }

    return index;
  }

  parseHTML(path) {
    this.files[path] = { path, tokens: {}, elements: 0 };

    const html = this.readHTML(path, true);

    for (let index = 0; index < html.length; index += 1) {
      index = this.manageTag(html, index);

      if (html[index] === '>') {
        const uuid = this.manageUUID(path);

        while (html[index + 1] && html[index + 1] !== '<') {
          index += 1;

          this.files[path].tokens[uuid] ||= '';
          this.files[path].tokens[uuid] += html[index];
        }

        this.manageText(path, uuid);
      }
    }
  }

  /** **********************************************************************************************
   **                                            Parse                                            **
   ********************************************************************************************** */

  parse() {
    this.files = {};

    this.file.paths.forEach((path) => {
      if (path.endsWith('.opf')) {
        this.writeOPF(path);
      }

      if (path.endsWith(this.metadata.cover_path)) {
        this.writeCover(path);
      }

      if (this.isHTML(path)) {
        this.parseHTML(path);
      }
    });

    this.parseQueries();

    this.emit('parsed');
  }

  /** **********************************************************************************************
   **                                        Init: Prompt                                         **
   ********************************************************************************************** */

  promptCover() {
    const cover = this.getCover();

    if (cover) return this.setCover(cover);

    return inquirer
      .prompt([
        {
          type: 'list',
          name: 'cover',
          message: `[${new Date().toISOString()}]  PROMPT - Veuillez choisir une cover:`,
          choices: _.filter(this.epub.manifest, (el) => el['media-type'].includes('image')).map(
            (image) => ({
              name: image.href,
              value: { id: image.id, href: image.href },
            })
          ),
        },
      ])
      .then((answers) => this.setCover(answers.cover));
  }

  promptMetadata() {
    return new Promise((resolve) => {
      prompt.get(
        [
          { name: 'title', description: 'Book title', default: this.epub.metadata.title },
          { name: 'subtitle', description: 'Book subtitle', default: this.epub.metadata.subtitle },
          { name: 'creator', description: 'Book creator', default: this.epub.metadata.creator },
          { name: 'series_name', description: 'Book series name' },
          { name: 'series_volume', description: 'Book series volume' },
        ],
        (_err, result) => {
          this.metadata.title = result.title;
          this.metadata.subtitle = result.subtitle;
          this.metadata.creator = result.creator;
          this.metadata.series_name = result.series_name;
          this.metadata.series_volume = result.series_volume;

          Logger.info(`${this.getInfos()} - INIT_METADATA`, this.metadata);

          resolve();
        }
      );
    });
  }

  /** **********************************************************************************************
   **                                            Init                                             **
   ********************************************************************************************** */

  initDatabase() {
    Database.setHash(this.file.hash);
    Database.setUser(this.params.user);
    Database.setSource(this.params.source);
    Database.setDestination(this.params.destination);

    Database.readRatios();
    Database.readTranslations();
  }

  initEpub() {
    if (fs.existsSync(this.file.folder)) {
      fs.rmSync(this.file.folder, { recursive: true, force: true });
    }

    this.epub.zip.admZip.extractAllTo(this.file.folder, true);
  }

  initPaths(dirpath = this.file.folder) {
    this.file.paths ||= [];

    fs.readdirSync(dirpath).forEach((filepath) => {
      const fullpath = `${dirpath}/${filepath}`;

      return fs.statSync(fullpath).isDirectory()
        ? this.initPaths(fullpath)
        : this.file.paths.push(fullpath);
    });
  }

  init() {
    this.epub = new EPUB(this.file.path);

    this.epub.on('end', async () => {
      this.initEpub();
      this.initPaths();
      this.initDatabase();

      await this.promptCover();
      await this.promptMetadata();

      this.emit('initiated');
    });

    this.epub.parse();
  }
}
