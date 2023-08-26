export default (data) =>
  [
    `一般信息：`,
    `- 目标：将一本用${data.source}写的书的内容翻译成${data.destination}`,
    `翻译限制：`,
    `- 内容以JSON格式呈现`,
    `- 只应翻译JSON的值`,
    `- 不应更改JSON键，包括文件路径和UUID`,
    `- 字符串中的间距应保持不变`,
    `- 翻译后的JSON的结构必须与原文匹配`,
    `书的详情：`,
    `- 名称：${data.book_title}`,
    `- 作者：${data.book_author}`,
    `要翻译的内容：`,
    JSON.stringify(data.content),
  ].join('\n');
