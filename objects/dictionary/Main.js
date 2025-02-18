/* eslint-disable max-len */
/* eslint-disable prefer-destructuring */
/* eslint-disable import/no-extraneous-dependencies */

/* eslint-disable no-restricted-syntax */

import _ from 'lodash';
import fs from 'fs';
import zip from 'archiver';

import sharp from 'sharp';
import axios from 'axios';
import prompt from 'prompt';
import ytdl from 'ytdl-core';
import mime from 'mime-types';
import beautify from 'simply-beautiful';

import { jsonrepair } from 'jsonrepair';
import { EventEmitter } from 'events';
import { minify } from 'html-minifier-terser';
import { createCanvas, loadImage } from 'canvas';
import { getSubtitles } from 'youtube-captions-scraper';

import Logger from '../../config/logger.js';
import Toolbox from '../../config/Toolbox.js';

import sendRequest from './Request.js';

export default class EpubInterface extends EventEmitter {
  constructor(params) {
    super();

    this.constants = {
      tmp: './tmp/epub/',
      default: './assets/epub/',
      html_folder: './tmp/epub/OPS/',
      chapter_template: `./tmp/epub/OPS/chapter_template.xhtml`,
      cover_name: `/epub/cover.png`,
      cover_type: `image/jpeg`,
      titlepage: './tmp/epub/titlepage.xhtml',
      database: './db/Database.json',
      gitkeep: './tmp/epub/.gitkeep',
      opf: './tmp/epub/content.opf',
      ncx: './tmp/epub/toc.ncx',
    };

    this.id = params.id;

    this.trigger = 2000;

    this.pathes = [];
    this.queries = [];

    this.params = {
      user: params.user || 'Default',
      language: params.language || 'French',
      model: params.model || 'gpt-4o-mini-2024-07-18',
    };

    this.timers = {
      queries: { id: null, interval: 1000 },
    };
  }

  /** **********************************************************************************************
   **                                           Getters                                           **
   ********************************************************************************************** */

  getInfos() {
    return `EPUB (${this.getVideoName()})`;
  }

  getQuery() {
    return _.find(Object.values(this.queries), (query) => !query.finish && !query.waiting);
  }

  getStatus() {
    const queries = Object.values(this.queries);

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

  getVideoName() {
    return `${this.video.title} - ${this.video.creator}`;
  }

  getEpubPath() {
    return `./library/Youtube/${this.getVideoName()}.epub`;
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

  /** **********************************************************************************************
   **                                           Helpers                                           **
   ********************************************************************************************** */

  hasFinish() {
    return Object.values(this.queries).every((query) => query.finish);
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
    const title = this.video.title;

    return title
      ? [
          `\t<dc:title id="t1">${title}</dc:title>`,
          `\t<meta property="title-type" refines="#t1">main</meta>`,
          `\t<meta property="display-seq" refines="#t1">1</meta>`,
        ].join('\n')
      : ``;
  }

  getMetadataSubtitle() {
    const { subtitle } = this.video;

    return subtitle
      ? [
          `\t<dc:title id="t2">${subtitle}</dc:title>`,
          `\t<meta property="title-type" refines="#t2">subtitle</meta>`,
          `\t<meta property="display-seq" refines="#t2">1</meta>`,
        ].join('\n')
      : ``;
  }

  getMetadataCreator() {
    const creator = this.video.creator;

    return creator ? `\t<dc:creator>${creator}</dc:creator>` : ``;
  }

  getMetadataPublisher() {
    return `\t<dc:publisher>The Babel Library</dc:publisher>`;
  }

  getMetadataLanguage() {
    const iso = Toolbox.getIsoCode(this.params.language);

    return iso ? `\t<dc:language>${iso}</dc:language>` : ``;
  }

  getMetadataCover() {
    return `\t<meta name="cover" content="cover"/>`;
  }

  getMetadata() {
    return _.compact([
      this.getMetadataTitle(),
      this.getMetadataSubtitle(),
      this.getMetadataCreator(),
      this.getMetadataPublisher(),
      this.getMetadataLanguage(),
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

  initPathes(dirpath = this.constants.tmp) {
    fs.readdirSync(dirpath).forEach((filepath) => {
      const fullpath = `${dirpath}/${filepath}`.replace('//', '/');

      return fs.statSync(fullpath).isDirectory()
        ? this.initPathes(fullpath)
        : this.pathes.push(fullpath);
    });
  }

  /** **********************************************************************************************
   **                                        Write: Cover                                         **
   ********************************************************************************************** */

  async getThumbnail() {
    try {
      const response = await axios({ url: this.video.thumbnail.url, responseType: 'arraybuffer' });

      await sharp(response.data).toFormat('png').toFile('tmp/epub/thumbnail.png');

      Logger.info(`${this.getInfos()} - WRITE_THUMBNAIL`);
    } catch (error) {
      Logger.error(`${this.getInfos()} - GET_THUMBNAIL`, error);
    }
  }

  async updateCover() {
    const cover = await loadImage('tmp/epub/cover.png');
    const logo = await loadImage('tmp/epub/thumbnail.png');
    const youtube = await loadImage('tmp/epub/youtube.jpg');

    const canvas = createCanvas(800, 1280);
    const context = canvas.getContext('2d');

    context.drawImage(cover, 0, 0, 800, 1280);
    context.drawImage(youtube, 0, 0, 800, 420);

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

    context.fillStyle = '#FFFFFF';
    context.textAlign = 'center';

    let fontSize = 54;

    context.font = `${fontSize}px "Times New Roman"`;

    while (context.measureText(this.video.title).width > 700 && fontSize > 20) {
      fontSize -= 2;
      context.font = `${fontSize}px "Times New Roman"`;
    }

    context.fillText(this.video.title, 400, 1050 - fontSize);

    fontSize = 54;
    context.font = `${fontSize}px "Times New Roman"`;

    while (context.measureText(this.video.creator).width > 500 && fontSize > 20) {
      fontSize -= 2;
      context.font = `${fontSize}px "Times New Roman"`;
    }

    context.fillText(this.video.creator, 400, 1050 + fontSize);

    const logoWidth = logo.width;
    const logoHeight = logo.height;
    const scale = Math.min(800 / logoWidth, 420 / logoHeight, 1);
    const scaledWidth = logoWidth * scale;
    const scaledHeight = logoHeight * scale;

    const centerX = (canvas.width - scaledWidth) / 2;
    const centerY = canvas.height / 3 + (canvas.height / 3 - scaledHeight) / 2;
    const borderRadius = 40;

    context.save();

    context.shadowColor = 'rgba(255, 0, 0, 0.8)';
    context.shadowBlur = 150;
    context.shadowOffsetX = 0;
    context.shadowOffsetY = 0;

    context.beginPath();
    context.roundRect(centerX, centerY, scaledWidth, scaledHeight, borderRadius + 20);
    context.fill();

    context.shadowColor = 'transparent';

    context.beginPath();
    context.roundRect(centerX, centerY, scaledWidth, scaledHeight, borderRadius);
    context.clip();

    context.drawImage(logo, centerX, centerY, scaledWidth, scaledHeight);

    context.restore();

    const buffer = canvas.toBuffer(mime.lookup('tmp/epub/cover.png'));
    fs.writeFileSync('tmp/epub/cover.png', buffer);
  }

  updateCoverOPF() {
    let file = this.readFile(this.constants.opf);

    file = file.replace('COVER_PATH', 'cover.png');

    file = file.replace('COVER_TYPE', 'image/png');

    this.writeFile(this.constants.opf, file);
  }

  updateCoverTitlepage() {
    let file = this.readFile(this.constants.titlepage);

    file = file.replace('TITLE', this.video.title);

    file = file.replace('COVER_PATH', 'cover.png');

    this.writeFile(this.constants.titlepage, file);
  }

  async writeCover() {
    this.updateCoverOPF();

    this.updateCoverTitlepage();

    await this.getThumbnail();

    await this.updateCover();
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

    this.writeFile(this.constants.ncx, content);
  }

  writeChapters() {
    let chapter = 1;

    this.queries.forEach((query) => {
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

    this.pathes.forEach((path) => {
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

    this.initPathes();

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
      author: this.video.creator,
      title: this.video.title,
      part: `${query.index}/${this.queries.length}`,
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
   **                                           Process                                           **
   ********************************************************************************************** */

  onProcessInterval() {
    this.sendSummarizeRequest();

    if (!this.hasFinish()) return;

    this.emit('processed');

    this.stopProcessInterval();
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
    this.queries.push({
      text: '',
      response: null,
      count: 0,
      waiting: false,
      finish: false,
      index: this.queries.length + 1,
    });
  }

  manageQuery(text) {
    const query = this.queries[this.queries.length - 1];

    const statsText = this.getTextStats(text);
    const statsQuery = this.getTextStats(query.text);

    if (statsQuery.words < this.trigger / 2) return query;

    if (statsText.words + statsQuery.words < this.trigger) return query;

    this.addQuery();

    return this.queries[this.queries.length - 1];
  }

  mergeQueries() {
    let last = null;

    this.queries.forEach((query) => {
      if (last?.finish === false && query.stats.words < this.trigger / 3) {
        last.text += query.text;
        last.stats = this.getTextStats(last.text);

        query.text = '';
        query.finish = true;
        query.stats = this.getTextStats(query.text);

        Logger.info(`${this.getInfos()} - MERGE_QUERY`, { last: last.index, index: query.index });
      }

      last = query;
    });
  }

  splitSection(text) {
    const textStats = this.getTextStats(text);

    if (textStats.words < this.trigger) return [text];

    const trigger = Math.round(textStats.words / Math.ceil(textStats.words / this.trigger));

    const result = [''];

    text.split(/\s+(?=what|when|i|je|tu\s)/i).forEach((sentence) => {
      const stats = this.getTextStats(result[result.length - 1]);

      if (stats.words >= trigger) {
        result.push(`${sentence} `);
      } else {
        result[result.length - 1] += ` ${sentence} `;
      }
    });

    return result;
  }

  parseQueries() {
    this.addQuery();

    this.video.chapters.forEach((chapter) => {
      let query = this.queries[this.queries.length - 1];

      query = this.manageQuery(chapter.text);

      this.splitSection(chapter.text).forEach((subText) => {
        query = this.manageQuery(subText);

        query.text += subText;

        query.text = query.text.replace(/\s+/g, ' ');

        query.stats = this.getTextStats(query.text);
      });
    });
  }

  parse() {
    this.parseQueries();

    this.mergeQueries();

    this.emit('parsed');
  }

  /** **********************************************************************************************
   **                                        Init: Prompt                                         **
   ********************************************************************************************** */

  promptMetadata() {
    return new Promise((resolve) => {
      prompt.get(
        [
          { name: 'title', description: 'Video title', default: this.video.title },
          { name: 'subtitle', description: 'Video subtitle', default: this.video.subtitle },
          { name: 'creator', description: 'Video creator', default: this.video.creator },
        ],
        (_err, result) => {
          this.video.title = result.title;
          this.video.subtitle = `Summarized by ${this.params.model}`;
          this.video.creator = result.creator;

          Logger.info(`${this.getInfos()} - INIT_METADATA`, {
            title: this.video.title,
            subtitle: this.video.subtitle,
            creator: this.video.creator,
          });

          resolve();
        }
      );
    });
  }

  /** **********************************************************************************************
   **                                            Init                                             **
   ********************************************************************************************** */

  parseTime(t) {
    return t
      .split(':')
      .reverse()
      .reduce((s, m, h) => s + Number(m) * 60 ** h, 0);
  }

  initVideoChapters() {
    const chapters = _.chain(this.video.description.split('\n'))
      .map((line) => line.trim())
      .filter((line) => /^[0-9]{1,2}:[0-9]{2}(?::[0-9]{2})?\s+/.test(line))
      .map((line) => {
        const match = line.match(/^([0-9]{1,2}(?::[0-9]{2}){1,2})\s+(.+)$/);

        return match ? { start: this.parseTime(match[1]), title: match[2].trim() } : null;
      })
      .compact()
      .value();

    this.video.chapters = chapters.map((chap, i) => ({
      start: chap.start,
      stop: i < chapters.length - 1 ? chapters[i + 1].start : this.video.length,
      title: chap.title,
      text: '',
    }));

    if (_.isEmpty(this.video.chapters)) {
      this.video.chapters.push({
        start: 0,
        stop: this.video.length,
        title: this.video.title,
        text: '',
      });
    }
  }

  async initVideoInfos(retry = 0) {
    try {
      const info = await ytdl.getBasicInfo(`https://www.youtube.com/watch?v=${this.id}`);

      this.video.title = info.player_response.videoDetails.title;
      this.video.creator = info.player_response.videoDetails.author;
      this.video.length = Number(info.player_response.videoDetails.lengthSeconds);
      this.video.description = info.player_response.videoDetails.shortDescription;
      this.video.thumbnail = _.maxBy(
        info.player_response.videoDetails.thumbnail.thumbnails,
        'width'
      );
    } catch (error) {
      if (retry >= 3) {
        Logger.fatal(`${this.getInfos()} - INIT_VIDEO_INFOS`, error);

        process.exit();
      } else {
        await this.initVideoInfos(retry + 1);
      }
    }
  }

  initSubtitles(index = 0) {
    const langs = ['en', 'fr', 'es', 'de', 'hi', 'pt', 'ru', 'ja', 'id', 'ar', 'th'];

    if (!langs[index]) {
      Logger.fatal(`${this.getInfos()} - INIT_SUBTITLES`);

      process.exit();
    }

    Logger.info(`${this.getInfos()} - INIT_SUBTITLES`, langs[index]);

    return getSubtitles({ videoID: this.id, lang: langs[index] })
      .then((captions) => {
        captions.forEach((caption) => {
          this.video.chapters.forEach((chapter) => {
            if (chapter.start < Number(caption.start) && Number(caption.start) < chapter.stop) {
              chapter.text += `${caption.text.replace(/\[[^\]]+\]\s*/g, '')} `;

              chapter.text = chapter.text.replace(/\s+/g, ' ');
            }
          });
        });
      })
      .catch(() => this.initSubtitles(index + 1));
  }

  async initVideo() {
    this.video = {};

    await this.initVideoInfos();

    this.initVideoChapters();

    await this.initSubtitles();
  }

  async init() {
    await this.initVideo();

    await this.promptMetadata();

    this.emit('initiated');
  }
}
