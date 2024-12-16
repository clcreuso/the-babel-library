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

import { jsonrepair } from 'jsonrepair';
import { EventEmitter } from 'events';
import { minify } from 'html-minifier-terser';
import { createCanvas, loadImage } from 'canvas';

import Logger from '../../config/logger.js';
import Toolbox from '../../config/Toolbox.js';

import sendRequest from '../queries/Request.js';

function cleanHtmlForEpub(html) {
  const options = {
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
  };

  return minify(html, options).then((res) => res.replace(/&(?!amp;)/g, '&amp;'));
}

export default class EpubInterface extends EventEmitter {
  constructor(params) {
    super();

    this.constants = {
      tmp: './tmp/epub/',
      default: './assets/epub/',
      chapter_folder: './tmp/epub/OPS/',
      chapter_template: `./tmp/epub/OPS/chapter_template.xhtml`,
      titlepage: './tmp/epub/titlepage.xhtml',
      database: './db/Database.json',
      gitkeep: './tmp/epub/.gitkeep',
      opf: './tmp/epub/content.opf',
      ncx: './tmp/epub/toc.ncx',
    };

    this.database = {};

    this.book = {
      chapters: [],
      queries: [],
      paths: [],
    };

    this.params = {
      user: params.user || 'Default',
      model: params.model || 'gpt-4o-2024-11-20',
      // model: params.model || 'claude-3-5-sonnet-latest',
      language: params.language || 'French',
      ratio: params.ratio || 10,
    };

    this.metadata = params.metadata || {};

    this.timers = {
      queries: { id: null, interval: 2000 },
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
    return `./library/${this.getEpubName()}.epub`;
  }

  hasTitleHTML(html, index) {
    if (html[index] !== '<' && html[index + 1] !== '/') return false;

    if (html[index] !== '<' && html[index + 1] === 'h') return true;

    if (!this.tags) return false;

    let tag = '';

    while (html[index] && html[index] !== '>') {
      tag += html[index];

      index += 1;
    }

    tag += html[index];

    return this.tags.includes(tag);
  }

  getTextHTML(html) {
    let result = '';

    for (let index = html.indexOf('body'); index < html.length; index += 1) {
      if (this.hasTitleHTML(html, index)) result += '|TITLE|';

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

    if (!html.includes('body')) return '';

    if (!this.hasContentFile(html)) {
      if (logs) Logger.warn(`${this.getInfos()} - NOT_CONTENT_FILE`, infos.href);

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

  hasFinish() {
    return Object.values(this.book.queries).every((query) => query.finish);
  }

  hasUselessContent(content, infos) {
    if (!content) return true;

    const stats = this.getTextStats(content);

    if (stats.words > 100) return false;

    if (stats.chars > 1000) return false;

    Logger.warn(`${this.getInfos()} - HAS_USELESS_CONTENT`, infos.href, stats);

    return true;
  }

  hasContentFile(html) {
    const upperCaseHTML = html.toUpperCase();

    const contentTypes = [
      'EPUB:TYPE="AFTERWORD"',
      'EPUB:TYPE="BODYMATTER"',
      'EPUB:TYPE="CHAPTER"',
      'EPUB:TYPE="CONCLUSION"',
      'EPUB:TYPE="EPIGRAPH"',
      'EPUB:TYPE="INTRODUCTION"',
      'EPUB:TYPE="PART"',
      'EPUB:TYPE="PREAMBLE"',
      'EPUB:TYPE="VOLUME"',
      'ROLE="DOC-CONCLUSION"',
      'ROLE="DOC-INTRODUCTION"',
    ];

    const nonContentTypes = [
      'TABLE_OF_CONTENTS',
      'EPUB:TYPE="ACKNOWLEDGMENTS"',
      'EPUB:TYPE="APPENDIX"',
      'EPUB:TYPE="AUDIO"',
      'EPUB:TYPE="BACKMATTER"',
      'EPUB:TYPE="BIBLIOGRAPHY"',
      'EPUB:TYPE="CODE"',
      'EPUB:TYPE="COLOPHON"',
      'EPUB:TYPE="COVER"',
      'EPUB:TYPE="COPYRIGHT"',
      'EPUB:TYPE="COPYRIGHT-PAGE"',
      'EPUB:TYPE="EXAMPLE"',
      'EPUB:TYPE="FIGURE"',
      'EPUB:TYPE="FOREWORD"',
      'EPUB:TYPE="FRONTMATTER"',
      'EPUB:TYPE="GLOSSARY"',
      'EPUB:TYPE="INDEX"',
      'EPUB:TYPE="PREFACE"',
      'EPUB:TYPE="QNA"',
      'EPUB:TYPE="SIDEBAR"',
      'EPUB:TYPE="TABLE"',
      'EPUB:TYPE="TITLEPAGE"',
      'EPUB:TYPE="TOC"',
      'EPUB:TYPE="VIDEO"',
      '©',
    ];

    for (const type of contentTypes) {
      if (upperCaseHTML.includes(type)) {
        return true;
      }
    }

    for (const type of nonContentTypes) {
      if (upperCaseHTML.includes(type)) {
        return false;
      }
    }

    return true;
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

  writeChapterOPF(index) {
    let content = this.readFile(this.constants.opf);

    const chapter = `chapter_${index + 1}`;

    const spine = `<itemref idref="${chapter}"/>`;
    const manifest = `<item id="${chapter}" href="OPS/${chapter}.xhtml" media-type="application/xhtml+xml"/>`;

    content = content.replace(/<\/spine>/, `\t${spine}\n\t</spine>`);
    content = content.replace(/<\/manifest>/, `\t${manifest}\n\t</manifest>`);

    this.writeFile(this.constants.opf, content);
  }

  writeChapterNCX(index) {
    let content = this.readFile(this.constants.ncx);

    const chapter = `chapter_${index + 1}`;

    const data = [
      `\t<navPoint playOrder="${index + 1}" class="chapter">`,
      `\t\t<navLabel><text>Chapitre ${index + 1}</text></navLabel>`,
      `\t\t<content src="OPS/${chapter}.xhtml"/>`,
      `\t</navPoint>`,
    ].join('\n');

    content = content.replace(/<\/navMap>/, `${data}\n</navMap>`);

    this.writeFile(this.constants.ncx, content);
  }

  writeChapters() {
    this.book.queries.forEach((query, index) => {
      if (!query.finish || !query.response) return;

      let file = this.readFile(this.constants.chapter_template);

      file = file.replace('TITLE', `Chapitre ${index + 1}`);

      let html = query.response.replace(/\s+/g, ' ').replaceAll('< /', '</');

      html = html.replace(/<br\s*\/?>/gi, '<br />');

      html = html.replace(/<h[1-6]/gi, '<h3');
      html = html.replace(/h[1-6]>/gi, 'h3>');

      html = html.replace(/<h3/i, '<h2');
      html = html.replace(/h3>/i, 'h2>');

      file = file.replace(
        /<body([^>]*)>([\s\S]*?)<\/body>/i,
        beautify.html(`<body$1>\n${html}\n</body>`)
      );

      this.writeFile(`${this.constants.chapter_folder}chapter_${index + 1}.xhtml`, file);

      this.writeChapterOPF(index);

      this.writeChapterNCX(index);
    });

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

      this.emit('writed');
    });

    this.book.paths.forEach((path) => {
      archive.append(fs.readFileSync(path), {
        name: path.replace(this.constants.tmp, ''),
      });
    });

    archive.finalize();
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
      return JSON.parse(this.getJSONRepair(data));
    } catch (error) {
      Logger.error(`${this.getInfos()} - PARSE_RESPONSE_JSON`, data, error);

      return undefined;
    }
  }

  manageDatabaseTriggers(query, response) {
    const ratio = query.words / response.words;

    if (ratio < 5 && query.words >= this.database.triggers.max) {
      this.database.triggers.min += 5;
      this.database.triggers.max += 10;

      Logger.info(`${this.getInfos()} - UP_TRIGGERS`, {
        ratio,
        triggers: this.database.triggers,
      });
    }

    if (ratio > 10 && query.words <= this.database.triggers.max) {
      this.database.triggers.min -= 10;
      this.database.triggers.max -= 20;

      Logger.info(`${this.getInfos()} - DOWN_TRIGGERS`, {
        ratio,
        triggers: this.database.triggers,
      });
    }
  }

  manageDatabaseRatio(query) {
    if (!query.response) return;

    const textStats = this.getTextStats(query.text);
    const responseStats = this.getTextStats(this.getTextHTML(query.response));

    this.database.history ||= [];

    this.database.history.push({ query: textStats, response: responseStats });

    if (this.database.history.length > 500) this.database.history.shift();

    this.manageDatabaseTriggers(textStats, responseStats);

    this.writeFile(this.constants.database, JSON.stringify(this.database, null, 2));
  }

  async parseSummarizeRequest(data, query) {
    try {
      query.count += 1;

      const response = this.parseResponseJSON(data);

      if (!response?.content) {
        query.response = undefined;
        query.finish = query.count > 2;
      } else {
        query.response = await cleanHtmlForEpub(response.content).catch((err) => {
          Logger.error(`${this.getInfos()} - CLEAN_HTML_FOR_EPUB`, err);

          return undefined;
        });

        this.manageDatabaseRatio(query);

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

    Logger.info(`${this.getInfos()} - SEND_SUMMARIZE_REQUEST`);
  }

  /** **********************************************************************************************
   **                                          Summarize                                          **
   ********************************************************************************************** */

  onSummarizeInterval() {
    this.sendSummarizeRequest();

    if (!this.hasFinish()) return;

    this.emit('summarized');

    this.stopSummarizeInterval();
  }

  stopSummarizeInterval() {
    clearInterval(this.timers.queries.id);

    this.timers.queries.id = null;
  }

  summarize() {
    this.stopSummarizeInterval();

    this.onSummarizeInterval();

    this.timers.queries.id = setInterval(() => {
      this.onSummarizeInterval();
    }, this.timers.queries.interval);

    Logger.info(`${this.getInfos()} - START_SUMMARIZE_INTERVAL`);
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

  manageQuery(text, onChapter = false) {
    const query = this.book.queries[this.book.queries.length - 1];

    const statsText = this.getTextStats(text);
    const statsQuery = this.getTextStats(query.text);

    if (statsText.words < this.database.triggers.max) {
      if (statsQuery.words < 250) return query;

      if (!onChapter && statsQuery.words < this.database.triggers.min) return query;

      if (statsText.words + statsQuery.words < this.database.triggers.max) return query;
    }

    this.addQuery();

    return this.book.queries[this.book.queries.length - 1];
  }

  parseQueries() {
    this.addQuery();

    this.book.chapters.forEach((chapter) => {
      if (_.isEmpty(chapter.sections)) return;

      let query = this.book.queries[this.book.queries.length - 1];

      if (chapter.sections.length > 1 && !_.isEmpty(query.text)) this.addQuery();

      query = this.manageQuery(chapter.sections.join(''), true);

      chapter.sections.forEach((section) => {
        query = this.manageQuery(section, true);

        section.split('|TITLE|').forEach((subText) => {
          query = this.manageQuery(subText);

          query.text += ` ${subText}`;

          query.text = query.text.replace(/\s+/g, ' ');

          query.stats = this.getTextStats(query.text);
        });
      });
    });
  }

  parseTagsHTML(path) {
    const html = this.readFile(path);

    if (!html.includes('body')) return {};

    if (!this.hasContentFile(html)) return {};

    const result = {};

    for (let index = html.indexOf('body'); index < html.length; index += 1) {
      if (html[index] === '<' && html[index + 1] !== '/') {
        let tag = '';

        while (html[index] && html[index] !== '>') {
          tag += html[index];

          index += 1;
        }

        tag += html[index];

        result[tag] ||= 0;
        result[tag] += 1;
      }
    }

    return result;
  }

  parseTags() {
    this.tags = {};

    this.epub.flow.forEach((infos) => {
      if (!infos.href.includes('appen')) {
        this.file.paths.forEach((path) => {
          if (!path.includes(infos.href)) return;

          const tags = this.parseTagsHTML(path);

          Object.entries(tags).forEach(([tag, value]) => {
            if (value <= 1) return;

            this.tags[tag] ||= 0;
            this.tags[tag] += value;
          });
        });
      }
    });

    Object.entries(this.tags).forEach(([tag, value]) => {
      if (value > this.epub.flow.length / 2 && value < this.epub.flow.length * 4) return;

      delete this.tags[tag];
    });

    this.tags = Object.keys(this.tags);
  }

  parse() {
    this.parseTags();

    this.files = {};

    let chapter = 0;

    this.epub.flow.forEach((infos) => {
      chapter = infos?.order || chapter;

      if (infos.href.includes('appen')) {
        Logger.warn(`${this.getInfos()} - HAS_APPEN_FILE`, infos.href);
      } else {
        this.book.chapters[chapter] ||= { chapter, sections: [] };

        this.file.paths.forEach((path) => {
          if (!path.includes(infos.href)) return;

          const text = this.parseTextHTML(path, infos, true);

          if (this.hasUselessContent(text, infos)) return;

          this.book.chapters[chapter].sections.push(text);
        });
      }
    });

    this.parseQueries();

    setTimeout(() => this.emit('parsed'), 5000);
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

  initDatabase() {
    this.database = JSON.parse(this.readFile(this.constants.database));

    this.database.triggers ||= { min: 2500, max: 5000 };

    this.database.history ||= [];

    this.database.history.forEach((el) => {
      this.manageDatabaseTriggers(el.query, el.response);
    });

    Logger.info(`${this.getInfos()} - INIT_DATABASE`);
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
      this.initDatabase();

      await this.promptCover();
      await this.promptMetadata();

      this.emit('initiated');
    });

    this.epub.parse();
  }
}
