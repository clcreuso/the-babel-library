export default (data) =>
  [
    `General Information:`,
    `- Objective: Translate the content of a book written in ${data.source} to ${data.destination}`,
    `Translation Constraints:`,
    `- The content is presented in JSON format`,
    `- Only the values of the JSON should be translated`,
    `- JSON keys, including file paths and UUIDs, should not be altered`,
    `- Spacing within character strings should be preserved`,
    `- The structure of the translated JSON must match the original`,
    `Book Details:`,
    `- Name: ${data.book_title}`,
    `- Written by: ${data.book_author}`,
    `Content to Translate:`,
    JSON.stringify(data.content),
  ].join('\n');
