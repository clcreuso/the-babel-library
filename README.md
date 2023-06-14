<div align="center">
   <h1 align="center">The Babel Library</h1>
   <br>
   <img src="/images/cover.png" width="50%">
</div>

<br>

   
The Babel Library is a Node.js script that translates EPUB files from one language to another using the OpenAI API. It leverages the power of artificial intelligence to provide automated translation capabilities for EPUB books.

## Prerequisites

Before running the script, make sure you have the following dependencies installed:

- Node.js (version 14 or higher)
- npm (Node Package Manager)

## Configuration

1. Clone the repository and navigate to the project directory.

2. Install the required dependencies by running the following command:

```
   npm install
```

3. Create a `.env` file in the project directory.

4. Open the `.env` file and add the following configuration variables:

```
   OPEN_AI_ORG=your_openai_organization_id
   OPEN_AI_KEY=your_openai_api_key
```

   Replace `your_openai_organization_id` and `your_openai_api_key` with your actual OpenAI organization ID and API key. These credentials are required to access the OpenAI API for translation.

## Usage

To translate an EPUB file, update the `script.js` file with the desired parameters:

```javascript
const translationParams = {
  path: '/path/to/your/epub/file.epub', // Path to the EPUB file you want to translate
  source: 'English', // Source language of the EPUB file
  destination: 'French', // Destination language for translation
};
```

Replace `/path/to/your/epub/file.epub` with the actual path to your EPUB file. Specify the source language and destination language for translation as desired.

Run the script by executing the following command:

```
node script.js
```

The script will translate the EPUB file and create a translated version in the destination language.

## License

This project is licensed under the MIT License. Feel free to modify and use it according to your needs.

## Disclaimer

Please note that this script relies on the OpenAI API for translation. Make sure you comply with the OpenAI usage guidelines and any applicable terms and conditions.
