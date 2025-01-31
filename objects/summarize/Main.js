/* eslint-disable max-len */
/* eslint-disable prefer-destructuring */
/* eslint-disable import/no-extraneous-dependencies */

/* eslint-disable no-restricted-syntax */

import _ from 'lodash';
import fs from 'fs';
import EPUB from 'epub';
import zip from 'archiver';

import prompt from 'prompt';
import mime from 'mime-types';
import inquirer from 'inquirer';
import beautify from 'simply-beautiful';

import { basename } from 'path';
import { jsonrepair } from 'jsonrepair';
import { EventEmitter } from 'events';
import { minify } from 'html-minifier-terser';
import { createCanvas, loadImage } from 'canvas';

import Logger from '../../config/logger.js';
import Toolbox from '../../config/Toolbox.js';

import CONSTANTS from './Constants.js';
import sendRequest from './Request.js';

export default class EpubInterface extends EventEmitter {
  constructor(params) {
    super();

    this.constants = {
      tmp: './tmp/epub/',
      default: './assets/epub/',
      html_folder: './tmp/epub/OPS/',
      conclusion: `./tmp/epub/OPS/conclusion.xhtml`,
      introduction: `./tmp/epub/OPS/introduction.xhtml`,
      chapter_template: `./tmp/epub/OPS/chapter_template.xhtml`,
      titlepage: './tmp/epub/titlepage.xhtml',
      database: './db/Database.json',
      gitkeep: './tmp/epub/.gitkeep',
      opf: './tmp/epub/content.opf',
      ncx: './tmp/epub/toc.ncx',
    };

    this.conclusion = { response: undefined, count: 0, waiting: false, finish: false };
    this.introduction = { response: undefined, count: 0, waiting: false, finish: false };

    this.database = {};

    this.book = {
      chapters: [],
      queries: [],
      paths: [],
    };

    this.trigger = 2500;

    this.params = {
      user: params.user || 'Default',
      model: params.model || 'gpt-4o-2024-11-20',
      language: params.language || 'French',
    };

    this.metadata = params.metadata || {};

    this.timers = {
      queries: { id: null, interval: 1000 },
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
    return _.find(Object.values(this.book.queries), (query) => !query.finish && !query.waiting);
  }

  getStatus() {
    const queries = Object.values(this.book.queries);

    const finisheds = _.filter(queries, (query) => query.finish).length;

    return `${this.getInfos()} - STATUS ${finisheds}/${queries.length}`;
  }

  getTextStats(text) {
    return {
      chars: text.length,
      words: Toolbox.countWords(text),
      sentences: Toolbox.countSentences(text),
    };
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
    const { title, subtitle, creator } = this.metadata;

    if (title && subtitle && creator) return `${title} - ${subtitle} | ${creator}`;

    if (title && creator) return `${title} | ${creator}`;

    return `${title}`;
  }

  getEpubPath() {
    return `./library/Summarized/${this.getEpubName()}.epub`;
  }

  getTextHTML(html) {
    let result = '';

    for (
      let index = html.includes('body') ? html.indexOf('body') : 0;
      index < html.length;
      index += 1
    ) {
      if (html[index] === '>') {
        while (html[index + 1] && html[index + 1] !== '<') {
          index += 1;

          result += html[index];
        }

        result += ' ';
      }
    }

    return result.replace(/\s+/g, ' ');
  }

  parseTextHTML(path, infos, logs = false) {
    const html = this.readFile(path);

    if (this.getContentType(html, infos.href) !== 'CHAPTER') {
      if (logs) Logger.warn(`${this.getInfos()} - USELESS_CONTENT`, infos.href);

      return '';
    }

    return this.getTextHTML(html);
  }

  /** **********************************************************************************************
   **                                           Setters                                           **
   ********************************************************************************************** */

  setCover(cover) {
    this.metadata.cover_id = cover.id;
    this.metadata.cover_name = cover.href.match(/[^/]+$/)[0];
    this.metadata.cover_path = cover.href;
    this.metadata.cover_type = cover['media-type'];
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

  hasChapters() {
    return this.epub.flow.some((infos) => _.isNumber(infos?.order));
  }

  hasFinish() {
    return Object.values(this.book.queries).every((query) => query.finish);
  }

  hasContentLong(html) {
    if (!html) return true;

    const stats = this.getTextStats(this.getTextHTML(html));

    if (stats.words < this.trigger / 2) return false;

    return true;
  }

  hasContentShort(html) {
    if (!html) return true;

    const stats = this.getTextStats(this.getTextHTML(html));

    if (stats.words > this.trigger / 20) return false;

    if (stats.chars > 200) return false;

    return true;
  }

  getContentPath(path, keywords) {
    if (!path) return false;

    for (const keyword of keywords) {
      if (new RegExp(keyword, 'i').test(path)) return true;
    }

    return false;
  }

  getContentLevel1(html, keywords) {
    for (const keyword of keywords) {
      const regexPatterns = [`ROLE="[^"]*DOC-${keyword}[^"]*"`, `EPUB:TYPE="[^"]*${keyword}[^"]*"`];

      for (const pattern of regexPatterns) {
        if (new RegExp(pattern, 'i').test(html)) return true;
      }
    }

    return false;
  }

  getContentLevel2(html, keywords) {
    const text = this.getTextHTML(html).slice(0, 100).toUpperCase();

    for (const keyword of keywords) {
      const regexPatterns = [
        `<(section|div|h1|h2|h3).*${keyword}.*/\\1>`,
        `<TITLE.*${keyword}.*/TITLE>`,
        `"${keyword}"`,
      ];

      if (text.includes(keyword)) return true;

      for (const pattern of regexPatterns) {
        if (new RegExp(pattern, 'i').test(html)) return true;
      }
    }

    return false;
  }

  getContentType(html, path) {
    const result = { value: 'CHAPTER', num: 0 };

    const types = { CHAPTER: 0, CONCLUSION: 0, INTRODUCTION: 0, TOC: 0, USELESS: 0 };

    if (html.includes('©')) types.USELESS += 5;

    if (this.hasContentShort(html)) types.USELESS += 5;

    if (this.getContentLevel1(html, CONSTANTS.L1.TOC)) types.TOC += 5;
    if (this.getContentLevel1(html, CONSTANTS.L1.CONCLUSION)) types.CONCLUSION += 5;
    if (this.getContentLevel1(html, CONSTANTS.L1.INTRODUCTION)) types.INTRODUCTION += 5;
    if (this.getContentLevel1(html, CONSTANTS.L1.USELESS)) types.USELESS += 3;
    if (this.getContentLevel1(html, CONSTANTS.L1.CHAPTER)) types.CHAPTER += 3;

    if (this.getContentPath(path, CONSTANTS.PATH.TOC)) types.TOC += 3;
    if (this.getContentPath(path, CONSTANTS.PATH.CONCLUSION)) types.CONCLUSION += 3;
    if (this.getContentPath(path, CONSTANTS.PATH.INTRODUCTION)) types.INTRODUCTION += 3;
    if (this.getContentPath(path, CONSTANTS.PATH.USELESS)) types.USELESS += 2;
    if (this.getContentPath(path, CONSTANTS.PATH.CHAPTER)) types.CHAPTER += 2;

    if (this.getContentLevel2(html, CONSTANTS.L2.TOC)) types.TOC += 2;
    if (this.getContentLevel2(html, CONSTANTS.L2.CONCLUSION)) types.CONCLUSION += 2;
    if (this.getContentLevel2(html, CONSTANTS.L2.INTRODUCTION)) types.INTRODUCTION += 2;
    if (this.getContentLevel2(html, CONSTANTS.L2.USELESS)) types.USELESS += 1;
    if (this.getContentLevel2(html, CONSTANTS.L2.CHAPTER)) types.CHAPTER += 1;

    if (this.hasContentLong(html)) {
      types.CHAPTER += 1;
      types.CONCLUSION = 0;
      types.INTRODUCTION = 0;
    }

    ['CHAPTER', 'TOC', 'CONCLUSION', 'INTRODUCTION', 'USELESS'].forEach((type) => {
      if (result.num >= types[type]) return;

      result.value = type;
      result.num = types[type];
    });

    return result.value;
  }

  readFile(path) {
    return fs.readFileSync(path).toString('utf8');
  }

  writeFile(path, content) {
    fs.writeFileSync(path, content, { encoding: 'utf8' });
  }

  /** **********************************************************************************************
   **                                         Write: OPF                                          **
   ********************************************************************************************** */

  getMetadataTitle() {
    const title = this.metadata.title || this.epub.metadata.title;

    return title
      ? [
          `\t<dc:title id="t1">${title}</dc:title>`,
          `\t<meta property="title-type" refines="#t1">main</meta>`,
          `\t<meta property="display-seq" refines="#t1">1</meta>`,
        ].join('\n')
      : ``;
  }

  getMetadataSubtitle() {
    const { subtitle } = this.metadata;

    return subtitle
      ? [
          `\t<dc:title id="t2">${subtitle}</dc:title>`,
          `\t<meta property="title-type" refines="#t2">subtitle</meta>`,
          `\t<meta property="display-seq" refines="#t2">1</meta>`,
        ].join('\n')
      : ``;
  }

  getMetadataCreator() {
    const creator = this.metadata.creator || this.epub.metadata.creator;

    return creator ? `\t<dc:creator>${creator}</dc:creator>` : ``;
  }

  getMetadataDate() {
    const { date } = this.epub.metadata;

    return date ? `\t<dc:date>${date}</dc:date>` : ``;
  }

  getMetadataPublisher() {
    const { publisher } = this.epub.metadata || 'The Babel Library';

    return publisher ? `\t<dc:publisher>${publisher}</dc:publisher>` : ``;
  }

  getMetadataLanguage() {
    const iso = Toolbox.getIsoCode(this.params.language);

    return iso ? `\t<dc:language>${iso}</dc:language>` : ``;
  }

  getMetadataSerie() {
    const { series_name } = this.metadata;

    return series_name ? `\t<meta name="calibre:series" content="${series_name}"/>` : ``;
  }

  getMetadataSeriesIndex() {
    const { series_volume } = this.metadata;

    return series_volume ? `\t<meta name="calibre:series_index" content="${series_volume}"/>` : ``;
  }

  getMetadataCover() {
    return this.metadata.cover_id
      ? `\t<meta name="cover" content="${this.metadata.cover_id}"/>`
      : ``;
  }

  getMetadata() {
    return _.compact([
      this.getMetadataTitle(),
      this.getMetadataSubtitle(),
      this.getMetadataCreator(),
      this.getMetadataDate(),
      this.getMetadataPublisher(),
      this.getMetadataLanguage(),
      this.getMetadataSerie(),
      this.getMetadataSeriesIndex(),
      this.getMetadataCover(),
    ]).join('\n');
  }

  writeOPF() {
    let content = this.readFile(this.constants.opf);

    content = content.replace(
      /(<metadata\b[^>]*>)([\s\S]*?)(<\/metadata>)/,
      `$1\n${this.getMetadata()}\n$3`
    );

    content = content.replace(/&(?!amp;)/g, '&amp;');

    this.writeFile(this.constants.opf, content);
  }

  /** **********************************************************************************************
   **                                        Write: Folder                                        **
   ********************************************************************************************** */

  initFolderEPUB() {
    fs.rmSync(this.constants.tmp, { recursive: true, force: true });

    fs.cpSync(this.constants.default, this.constants.tmp, { recursive: true });

    fs.rmSync(this.constants.gitkeep);
  }

  initBookPaths(dirpath = this.constants.tmp) {
    fs.readdirSync(dirpath).forEach((filepath) => {
      const fullpath = `${dirpath}/${filepath}`;

      return fs.statSync(fullpath).isDirectory()
        ? this.initBookPaths(fullpath)
        : this.book.paths.push(fullpath);
    });
  }

  /** **********************************************************************************************
   **                                        Write: Cover                                         **
   ********************************************************************************************** */

  async updateCover(path) {
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
    context.fillText(`-- Summarized --`, 142, 70);

    const buffer = canvas.toBuffer(mime.lookup(path));

    fs.writeFileSync(path, buffer);
  }

  updateCoverOPF() {
    let file = this.readFile(this.constants.opf);

    file = file.replace('COVER_PATH', this.metadata.cover_name);

    file = file.replace('COVER_TYPE', this.metadata.cover_type);

    this.writeFile(this.constants.opf, file);
  }

  updateCoverTitlepage() {
    let file = this.readFile(this.constants.titlepage);

    file = file.replace('TITLE', this.epub.metadata.title);

    file = file.replace('COVER_PATH', this.metadata.cover_name);

    this.writeFile(this.constants.titlepage, file);
  }

  async writeCover() {
    const coverPath = this.file.paths.find((path) => path.endsWith(this.metadata.cover_path));

    this.updateCoverOPF();

    this.updateCoverTitlepage();

    await this.updateCover(coverPath);

    fs.cpSync(coverPath, `${this.constants.tmp}${this.metadata.cover_name}`);
  }

  /** **********************************************************************************************
   **                                       Write: Chapters                                       **
   ********************************************************************************************** */

  writeFileInOPF(id) {
    let content = this.readFile(this.constants.opf);

    const spine = `<itemref idref="${id}"/>`;
    const manifest = `<item id="${id}" href="OPS/${id}.xhtml" media-type="application/xhtml+xml"/>`;

    content = content.replace(/<\/spine>/, `\t${spine}\n\t</spine>`);
    content = content.replace(/<\/manifest>/, `\t${manifest}\n\t</manifest>`);

    this.writeFile(this.constants.opf, content);
  }

  writeFileInNCX(order, type = 'chapter') {
    let content = this.readFile(this.constants.ncx);

    if (type === 'chapter') {
      content = content.replace(
        /<\/navMap>/,
        `${[
          `\t<navPoint playOrder="${order + 1}" class="chapter">`,
          `\t\t<navLabel><text>Chapitre ${order}</text></navLabel>`,
          `\t\t<content src="OPS/chapter_${order}.xhtml"/>`,
          `\t</navPoint>`,
        ].join('\n')}\n</navMap>`
      );
    }

    if (type === 'introduction') {
      content = content.replace(
        /<\/navMap>/,
        `${[
          `\t<navPoint playOrder="${order}" class="introduction">`,
          `\t\t<navLabel><text>Introduction</text></navLabel>`,
          `\t\t<content src="OPS/introduction.xhtml"/>`,
          `\t</navPoint>`,
        ].join('\n')}\n</navMap>`
      );
    }

    if (type === 'conclusion') {
      content = content.replace(
        /<\/navMap>/,
        `${[
          `\t<navPoint playOrder="${order}" class="conclusion">`,
          `\t\t<navLabel><text>Conclusion</text></navLabel>`,
          `\t\t<content src="OPS/conclusion.xhtml"/>`,
          `\t</navPoint>`,
        ].join('\n')}\n</navMap>`
      );
    }

    this.writeFile(this.constants.ncx, content);
  }

  writeChapters() {
    let chapter = 1;

    this.writeIntroduction(chapter);

    this.book.queries.forEach((query) => {
      if (!query.finish || !query.response) return;

      let file = this.readFile(this.constants.chapter_template);

      file = file.replace('TITLE', `Chapitre ${chapter}`);

      file = file.replace(
        /<body([^>]*)>([\s\S]*?)<\/body>/i,
        beautify.html(`<body$1>\n${query.response}\n</body>`)
      );

      file = file.replace(/(\s*\n\s*)+/g, '\n');

      this.writeFile(`${this.constants.html_folder}chapter_${chapter}.xhtml`, file);

      this.writeFileInOPF(`chapter_${chapter}`);

      this.writeFileInNCX(chapter);

      chapter += 1;
    });

    this.writeConclusion(chapter);

    fs.rmSync(this.constants.chapter_template);
  }

  /** **********************************************************************************************
   **                                            Write                                            **
   ********************************************************************************************** */

  writeEPUB() {
    const output = fs.createWriteStream(this.getEpubPath());
    const archive = zip('zip', { store: false });

    archive.on('error', (archiveErr) => {
      throw archiveErr;
    });

    archive.pipe(output);

    output.on('close', () => {
      Logger.info(`${this.getInfos()} - WRITE_EPUB "${this.getEpubPath()}"`);

      fs.cpSync(this.file.path, `./library/Summarized/Sources/${basename(this.file.path)}`);

      this.emit('writed');
    });

    this.book.paths.forEach((path) => {
      archive.append(fs.readFileSync(path), {
        name: path.replace(this.constants.tmp, ''),
      });
    });

    archive.finalize();
  }

  writeIntroduction(chapter) {
    if (!this.introduction.finish || !this.introduction.response) return;

    let file = this.readFile(this.constants.introduction);

    file = file.replace(
      /<body([^>]*)>([\s\S]*?)<\/body>/i,
      beautify.html(`<body$1>\n${this.introduction.response}\n</body>`)
    );

    file = file.replace(/(\s*\n\s*)+/g, '\n');

    this.writeFile(`${this.constants.html_folder}introduction.xhtml`, file);

    this.writeFileInOPF('introduction');

    this.writeFileInNCX(chapter, 'introduction');
  }

  writeConclusion(chapter) {
    if (!this.conclusion.finish || !this.conclusion.response) return;

    let file = this.readFile(this.constants.conclusion);

    file = file.replace(
      /<body([^>]*)>([\s\S]*?)<\/body>/i,
      beautify.html(`<body$1>\n${this.conclusion.response}\n</body>`)
    );

    file = file.replace(/(\s*\n\s*)+/g, '\n');

    this.writeFile(`${this.constants.html_folder}conclusion.xhtml`, file);

    this.writeFileInOPF('conclusion');

    this.writeFileInNCX(chapter + 1, 'conclusion');
  }

  async write() {
    this.initFolderEPUB();

    this.writeOPF();

    this.writeChapters();

    await this.writeCover();

    this.initBookPaths();

    this.writeEPUB();
  }

  /** **********************************************************************************************
   **                                     Summarize: Request                                      **
   ********************************************************************************************** */

  parseHTML(html) {
    return minify(html, {
      collapseWhitespace: true,
      keepClosingSlash: true,
      minifyCSS: true,
      minifyJS: true,
      removeComments: true,
      removeEmptyAttributes: true,
      removeRedundantAttributes: true,
      removeScriptTypeAttributes: true,
      removeStyleLinkTypeAttributes: true,
      useShortDoctype: true,
    }).then((res) => {
      res = res.replace(/&(?!amp;)/g, '&amp;');

      res = res.replaceAll('< /', '</');

      res = res.replace(/\s+/g, ' ');

      res = res.replace(/<br\s*\/?>/gi, '<br />');

      res = res.replace(/<h>/gi, '<h3>');
      res = res.replace(/<\/h>/gi, '</h3>');

      res = res.replace(/<h[1-6]/gi, '<h3');
      res = res.replace(/h[1-6]>/gi, 'h3>');

      res = res.replace(/<h3/i, '<h2');
      res = res.replace(/h3>/i, 'h2>');

      return res;
    });
  }

  isValidLanguage(html) {
    const text = this.getTextHTML(html);

    return text.includes('é') || text.includes('è');
  }

  getJSONRepair(str) {
    try {
      let result = str.slice(str.indexOf('{'), str.lastIndexOf('}') + 1);

      result = result.replaceAll(': undefined', ': "undefined"');

      return jsonrepair(result);
    } catch (error) {
      Logger.error(`${this.getInfos()} - GET_JSON_REPAIR`, str, error);

      return str;
    }
  }

  parseResponseJSON(data) {
    if (data.length < 100) return undefined;

    try {
      const json = JSON.parse(this.getJSONRepair(data));

      if (!this.isValidLanguage(json.content)) {
        Logger.warn(`${this.getInfos()} - INVALID_LANGUAGE`, json.content);

        return undefined;
      }

      return json;
    } catch (error) {
      Logger.error(`${this.getInfos()} - PARSE_RESPONSE_JSON`, data, error);

      return undefined;
    }
  }

  async parseSummarizeRequest(data, query) {
    try {
      query.count += 1;

      const response = this.parseResponseJSON(data);

      if (!response?.content) {
        query.response = undefined;
        query.finish = query.count > 2;
      } else {
        query.response = await this.parseHTML(response.content).catch((err) => {
          Logger.error(`${this.getInfos()} - PARSE_HTML_REQUEST_SUMMARIZE`, err);

          return undefined;
        });

        query.finish = query.response !== undefined || query.count > 2;
      }
    } catch (error) {
      Logger.error(`${this.getInfos()} - PARSE_SUMMARIZE_REQUEST`, error, data);
    }
  }

  sendSummarizeRequest(query = this.getQuery()) {
    if (!query) return;

    query.waiting = true;

    sendRequest({
      type: 'chapter',
      model: this.params.model,
      language: this.params.language,
      title: this.epub.metadata.title,
      author: this.epub.metadata.creator,
      content: query.text,
    })
      .then((response) => {
        this.parseSummarizeRequest(response, query);

        Logger.info(this.getStatus());
      })
      .catch((err) => {
        Logger.error(`${this.getInfos()} - SEND_SUMMARIZE_REQUEST`, err.response?.data || err);
      })
      .finally(() => {
        query.waiting = false;
      });

    Logger.info(`${this.getInfos()} - SEND_SUMMARIZE_REQUEST`, this.getTextStats(query.text));
  }

  /** **********************************************************************************************
   **                                         Introduction                                        **
   ********************************************************************************************** */

  getSubjectOPF() {
    const path = _.find(this.file.paths, (el) => el.includes('.opf'));

    const html = this.readFile(path);

    const regex = /<dc:(subject|description)>([\s\S]*?)<\/dc:\1>/g;

    const matches = [...html.matchAll(regex)];

    const results = matches.map((match) => match[2]?.trim());

    return results.join(' ') || '';
  }

  getIntroductionContent() {
    let text = this.getSubjectOPF();

    this.epub.flow.forEach((infos) => {
      this.file.paths.forEach((path) => {
        if (!path.includes(infos.href)) return;

        const html = this.readFile(path);

        if (this.getContentType(html, infos.href) !== 'INTRODUCTION') return;

        text += this.getTextHTML(html);
      });
    });

    return text;
  }

  async parseIntroductionRequest(data) {
    try {
      this.introduction.count += 1;

      const response = this.parseResponseJSON(data);

      if (!response?.content) {
        this.introduction.response = undefined;
        this.introduction.finish = this.introduction.count > 2;

        Logger.error(`${this.getInfos()} - PARSE_INTRODUCTION_REQUEST`, response);
      } else {
        this.introduction.response = await this.parseHTML(response.content).catch((err) => {
          Logger.error(`${this.getInfos()} - PARSE_HTML_REQUEST_INTRODUCTION`, err);

          return undefined;
        });

        this.introduction.finish =
          this.introduction.response !== undefined || this.introduction.count > 2;

        Logger.info(`${this.getInfos()} - PARSE_INTRODUCTION_REQUEST`);
      }
    } catch (error) {
      Logger.error(`${this.getInfos()} - PARSE_INTRODUCTION_REQUEST`, error, data);
    }
  }

  sendIntroductionRequest() {
    this.introduction.waiting = true;

    const content = this.getIntroductionContent();

    Logger.info(`${this.getInfos()} - SEND_INTRODUCTION_REQUEST`);

    sendRequest({
      type: 'introduction',
      model: this.params.model,
      language: this.params.language,
      title: this.epub.metadata.title,
      author: this.epub.metadata.creator,
      content,
    })
      .then((response) => {
        this.parseIntroductionRequest(response);
      })
      .catch((err) => {
        Logger.error(`${this.getInfos()} - SEND_INTRODUCTION_REQUEST`, err.response?.data || err);
      })
      .finally(() => {
        this.introduction.waiting = false;
      });
  }

  /** **********************************************************************************************
   **                                         Conclusion                                        **
   ********************************************************************************************** */

  getConclusionContent() {
    let text = this.getSubjectOPF();

    this.epub.flow.forEach((infos) => {
      this.file.paths.forEach((path) => {
        if (!path.includes(infos.href)) return;

        const html = this.readFile(path);

        if (this.getContentType(html, infos.href) !== 'CONCLUSION') return;

        text += this.getTextHTML(html);
      });
    });

    return text;
  }

  async parseConclusionRequest(data) {
    try {
      this.conclusion.count += 1;

      const response = this.parseResponseJSON(data);

      if (!response?.content) {
        this.conclusion.response = undefined;
        this.conclusion.finish = this.conclusion.count > 2;

        Logger.error(`${this.getInfos()} - PARSE_CONCLUSION_REQUEST`, response);
      } else {
        this.conclusion.response = await this.parseHTML(response.content).catch((err) => {
          Logger.error(`${this.getInfos()} - PARSE_HTML_REQUEST_CONCLUSION`, err);

          return undefined;
        });

        this.conclusion.finish =
          this.conclusion.response !== undefined || this.conclusion.count > 2;

        Logger.info(`${this.getInfos()} - PARSE_CONCLUSION_REQUEST`);
      }
    } catch (error) {
      Logger.error(`${this.getInfos()} - PARSE_CONCLUSION_REQUEST`, error, data);
    }
  }

  sendConclusionRequest() {
    this.conclusion.waiting = true;

    const content = this.getConclusionContent();

    Logger.info(`${this.getInfos()} - SEND_CONCLUSION_REQUEST`);

    sendRequest({
      type: 'conclusion',
      model: this.params.model,
      language: this.params.language,
      title: this.epub.metadata.title,
      author: this.epub.metadata.creator,
      content,
    })
      .then((response) => {
        this.parseConclusionRequest(response);
      })
      .catch((err) => {
        Logger.error(`${this.getInfos()} - SEND_CONCLUSION_REQUEST`, err.response?.data || err);
      })
      .finally(() => {
        this.conclusion.waiting = false;
      });
  }

  /** **********************************************************************************************
   **                                           Process                                           **
   ********************************************************************************************** */

  onProcessInterval() {
    if (!this.introduction.finish && !this.introduction.waiting) {
      this.sendIntroductionRequest();
    } else if (!this.conclusion.finish && !this.conclusion.waiting) {
      this.sendConclusionRequest();
    } else {
      this.sendSummarizeRequest();

      if (!this.hasFinish()) return;

      this.emit('processed');

      this.stopProcessInterval();
    }
  }

  stopProcessInterval() {
    clearInterval(this.timers.queries.id);

    this.timers.queries.id = null;
  }

  process() {
    this.stopProcessInterval();

    this.timers.queries.id = setInterval(() => {
      this.onProcessInterval();
    }, this.timers.queries.interval);

    Logger.info(`${this.getInfos()} - START_PROCESS_INTERVAL`);
  }

  /** **********************************************************************************************
   **                                            Parse                                            **
   ********************************************************************************************** */

  addQuery() {
    this.book.queries.push({
      text: '',
      response: null,
      count: 0,
      waiting: false,
      finish: false,
    });
  }

  manageQuery(text) {
    const query = this.book.queries[this.book.queries.length - 1];

    const statsText = this.getTextStats(text);
    const statsQuery = this.getTextStats(query.text);

    if (statsQuery.words < this.trigger / 2) return query;

    if (statsText.words + statsQuery.words < this.trigger) return query;

    this.addQuery();

    return this.book.queries[this.book.queries.length - 1];
  }

  mergeQueries() {
    let last = null;

    this.book.queries.forEach((query) => {
      if (last?.finish === false && query.stats.words < this.trigger / 3) {
        last.text += query.text;
        last.stats = this.getTextStats(last.text);

        query.text = '';
        query.finish = true;
        query.stats = this.getTextStats(query.text);
      }

      last = query;
    });
  }

  splitSection(text) {
    const textStats = this.getTextStats(text);

    if (textStats.words < this.trigger) return [text];

    const trigger = Math.round(textStats.words / Math.ceil(textStats.words / this.trigger));

    const result = [''];

    text.split('.').forEach((sentence) => {
      const stats = this.getTextStats(result[result.length - 1]);

      if (stats.words >= trigger) {
        result.push(`${sentence}.`);
      } else {
        result[result.length - 1] += ` ${sentence}.`;
      }
    });

    return result;
  }

  parseQueries() {
    this.addQuery();

    this.book.chapters.forEach((chapter) => {
      if (_.isEmpty(chapter.sections)) return;

      let query = this.book.queries[this.book.queries.length - 1];

      query = this.manageQuery(chapter.sections.join(''));

      chapter.sections.forEach((section) => {
        this.splitSection(section).forEach((subText) => {
          query = this.manageQuery(subText);

          query.text += subText;

          query.text = query.text.replace(/\s+/g, ' ');

          query.stats = this.getTextStats(query.text);
        });
      });
    });
  }

  parse() {
    this.files = {};

    let chapter = 0;

    this.epub.flow.forEach((infos, index) => {
      chapter = this.hasChapters() ? infos?.order || chapter : index;

      this.book.chapters[chapter] ||= { chapter, sections: [] };

      this.file.paths.forEach((path) => {
        if (!path.includes(infos.href)) return;

        const text = this.parseTextHTML(path, infos, true);

        this.book.chapters[chapter].sections.push(text);
      });
    });

    this.parseQueries();

    this.mergeQueries();

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
          this.metadata.title = `${result.title} (résumé)`;
          this.metadata.subtitle = `Summarized by ${this.params.model}`;
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

    this.epub.on('error', async (error) => {
      Logger.fatal(`${this.getInfos()} - INIT - ERRROR`, error);

      process.exit(-1);
    });

    this.epub.on('end', async () => {
      this.initEpub();
      this.initPaths();

      await this.promptCover();
      await this.promptMetadata();

      this.emit('initiated');
    });

    this.epub.parse();
  }
}
