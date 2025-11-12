const path = require('path');
const propertiesFormatParser = require('properties-parser');
const { JsonDiffer } = require('json-difference');
const jsondifference = new JsonDiffer();

const LANG_ISO_PLACEHOLDER = '%LANG_ISO%';

let _context;
let _lokalise;
let _fs;
let _vcs;


module.exports = async (context, { LokaliseApi, fs, vcs, debug }) => {
  _context = context;
  _lokalise = new LokaliseApi({ apiKey: context.apiKey });
  _fs = fs;
  _vcs = vcs;

  const compareResult = await _vcs.compare(context.targetRef, context.ref);

  if (!compareResult.commits || compareResult.commits.length === 0) {
    return "No ahead commits";
  }

  const diffSequence = await composeDiffSequence(compareResult);

  if (!Object.keys(diffSequence).length) {
    return "No changes in i18n files found"; // should never appear and be prevented by workflow rules
  }

  const keysToCreate = {};
  const keysToUpdate = {};
  const keysToDelete = new Set();

  const supportedLanguages = (await _lokalise.languages.list({ project_id: _context.projectId })).items.map(i => i.lang_iso);

  composeActionsFromDiffSequence(diffSequence, keysToCreate, keysToUpdate, keysToDelete, supportedLanguages);

  Object.keys(keysToCreate).filter(key => !Object.keys(keysToCreate[key]).length).forEach(key => delete keysToCreate[key]);

  const keysToCreateList = Object.keys(keysToCreate);
  const failedToCreateKeys = [];
  if (keysToCreateList.length) {
    const createConfig = {};
    if (keysToCreateList.toString().length < 6000) {
      createConfig.filter_keys = keysToCreateList.toString();
    }
    const existingKeysResult = await getRemoteKeys(createConfig);

    let allToCreateInPlace = false;
    if (existingKeysResult.length < keysToCreateList.length) {
      Object.keys(keysToCreate).forEach(key => {
        if (existingKeysResult.find(keyObj => keyObj.key_name[_context.platform] === key)) {
          delete keysToCreate[key];
        }
      })
    } else if ('filter_keys' in createConfig) {
      allToCreateInPlace = true;
    }


    if (!allToCreateInPlace && Object.keys(keysToCreate).length > 0) {
      const createRequest = buildLokaliseCreateKeysRequest(keysToCreate);
      console.log(`Pushing ${createRequest.length} new keys to Lokalise`);
      const createResult = debug ? {items: [], errors: []} : await _lokalise.keys.create(createRequest, { project_id: _context.projectId });
      createResult.items.forEach(keyObj => {
        delete keysToUpdate[keyObj.key_name[_context.platform]]
      });
      failedToCreateKeys.push(...createResult.errors.filter(e => e.message === 'This key name is already taken').map(e => e.key_name[_context.platform]));
      // TODO handle other errors? Are there any?
      console.log(`Push done! Success: ${createResult.items.length}; error: ${createResult.errors.length}.`);
    }
  }

  const keysToUpdateList = [...new Set(Object.keys(keysToUpdate).concat(failedToCreateKeys))];
  if (keysToUpdateList.length) {
    const updateConfig = { include_translations: 1 };
    if (keysToUpdateList.toString().length < 6000) {
      updateConfig.filter_keys = keysToUpdateList.toString();
    }
    const keysToUpdateData = await getRemoteKeys(updateConfig);

    const translationsIds = keysToUpdateData.reduce((memo, keyObj) => {
      const key = keyObj.key_name[_context.platform];
      memo[key] = keyObj.translations.reduce((memo1, translationObj) => {
        const lang = translationObj.language_iso;
        if ((keysToUpdate[key] || {})[lang] !== undefined && (translationObj.translation === keysToUpdate[key][lang] ||
            translationObj.modified_at_timestamp * 1000 > +new Date(diffSequence[lang][diffSequence[lang].length - 1].date))) {
          delete keysToUpdate[key][lang];
        }
        memo1[lang] = translationObj.translation_id;
        return memo1;
      }, {});
      return memo;
    }, {});

    Object.keys(keysToUpdate).filter(key => !Object.keys(keysToUpdate[key]).length || !(key in translationsIds)).forEach(key => delete keysToUpdate[key]);

    if (Object.keys(keysToUpdate).length) {
      console.log(`Updating translations for following keys on Lokalise: \n    ${Object.keys(keysToUpdate).join('\n    ')}`)
      for (const key in keysToUpdate) {
        for (const language in keysToUpdate[key]) {
          try {
            if (!debug) {
              await _lokalise.translations.update(
                  translationsIds[key][language],
                  { translation: keysToUpdate[key][language] },
                  { project_id: _context.projectId }
              );
            }
          } catch(e) {
            if(e.message === 'Expecting translation to be a JSON object with defined plural forms (UTF-8)') {

            } else {
              throw e;
            }
          }
        }
      }
      console.log('Update is done!');
    }
  }

  if (keysToDelete.size) {
    const deleteConfig = {};
    const keysToDeleteList = [ ...keysToDelete ];
    if (keysToDeleteList.toString().length < 6000) {
      deleteConfig.filter_keys = keysToDeleteList.toString();
    }
    const keysToDeleteData = await getRemoteKeys(deleteConfig);
    const keyIdsToDelete = keysToDeleteList.map(key => {
      const foundKey = keysToDeleteData.find(keyObj => keyObj.key_name[_context.platform] === key);
      return foundKey ? foundKey.key_id : null;
    }).filter(keyId => keyId);
    if (keyIdsToDelete.length) {
      console.log(`Deleting keys from Lokalise: \n    ${keysToDeleteData.map(
          keyObj => keyObj.key_name[_context.platform]).join('\n    ')}`);
      if (!debug) {
        await _lokalise.keys.bulk_delete(keyIdsToDelete, { project_id: _context.projectId });
      }
      console.log(`Delete request is done!`);
    }
  }
}

async function composeDiffSequence(compareResult) {
  const filenamePattern = new RegExp(_context.filename.replace(LANG_ISO_PLACEHOLDER, '(\\w\\w)').substr(1));

  const diffSequence = {};
  // const filesContent = {};
  const previousContents = {};
  for (const commit of compareResult.commits) {
    const commitResult = await _vcs.getCommit(commit.id || commit.sha);
    const i18nFiles = commitResult.files.filter(file => filenamePattern.test(file.filename));

    for (const file of i18nFiles) {
      const language = file.filename.match(filenamePattern)[1];

      const jsonFileContent = await getFileContent(file.filename, commit.sha).catch((e) => {
        if (e.name === 'SyntaxError' || e.status === 404) {
          return null;
        }
        throw e;
      });
      if (!jsonFileContent) {
        continue;
      }

      // filesContent[commit.sha] ||= {};
      // filesContent[commit.sha][language] ||= jsonFileContent;

      const parentSha = (commitResult.parents && commitResult.parents[0] && commitResult.parents[0].sha) || (commit.parents && commit.parents[0] && commit.parents[0].sha);
      const jsonPreviousContent = previousContents[language] || await getFileContent(file.filename, parentSha).catch((e) => {
        if (e.name === 'SyntaxError' || e.status === 404) {
          return null;
        }
        throw e;
      });

      if (!jsonPreviousContent) {
        continue;
      }

      const jsonDifferenceResult = jsondifference.getDiff(jsonPreviousContent, jsonFileContent);
      if (Object.keys(jsonDifferenceResult.new).length ||
          Object.keys(jsonDifferenceResult.removed).length ||
          jsonDifferenceResult.edited.length) {
        if (!diffSequence[language]) {
          diffSequence[language] = [];
        }
        diffSequence[language].push({
          diff: jsonDifferenceResult,
          date: commitResult.committedAt || commit.committedAt
        });
      }

      previousContents[language] = jsonFileContent;
    }
  }

  return diffSequence;
}

async function getFileContent(path, ref) {
  const fileContent = await _vcs.getFileContent(path, ref);

  if (_context.format === 'properties') {
    return propertiesFormatParser.parse(fileContent);
  } else {
    return JSON.parse(fileContent);
  }
}

function composeActionsFromDiffSequence (diffSequence, keysToCreate, keysToUpdate, keysToDelete, supportedLanguages) {
  Object.keys(diffSequence).filter(l => supportedLanguages.includes(l))
  .sort((a, b) => {
    if (a === 'en') return 1;
    if (b === 'en') return -1;
    return 0;
  }) // 'en' always in the end
  .forEach(language => {
    const fileDiffSequence = diffSequence[language];
    fileDiffSequence.forEach(({ diff: change }) => {
      Object.keys(change.new).forEach(key => {
        const normalizedKey = normalizeKey(key);
        if (!keysToCreate[normalizedKey]) {
          keysToCreate[normalizedKey] = {};
        }
        keysToCreate[normalizedKey][language] = change.new[key];
        if (change.new[key]) {
          if (!keysToUpdate[normalizedKey]) {
            keysToUpdate[normalizedKey] = {};
          }
          keysToUpdate[normalizedKey][language] = change.new[key];
        }
        if (keysToDelete.has(normalizedKey)) {
          keysToDelete.delete(normalizedKey);
        }
      });
      change.edited.forEach(edited => {
        const key = Object.keys(edited)[0];
        const normalizedKey = normalizeKey(key);
        if ((keysToCreate[normalizedKey] || {})[language]) {
          keysToCreate[normalizedKey][language] = edited[key].newvalue;
        }
        if (!keysToUpdate[normalizedKey]) {
          keysToUpdate[normalizedKey] = {};
        }
        if (keysToDelete.has(normalizedKey)) {
          keysToDelete.delete(normalizedKey);
        }
        keysToUpdate[normalizedKey][language] = edited[key].newvalue;
      });
      Object.keys(change.removed).forEach(key => {
        key = normalizeKey(key);
        if ((keysToCreate[key] || {})[language] !== undefined) {
          delete keysToCreate[key][language];
          if (!Object.keys(keysToCreate[key]).length) {
            delete keysToCreate[key];
            keysToDelete.add(key); // deleting anyway, as it might have been already committed to the server
          }
        }

        if (language === 'en') {
          keysToDelete.add(key);
          if (key in keysToUpdate) {
            delete keysToUpdate[key]
          }
        } else {
          if (!keysToUpdate[key]) {
            keysToUpdate[key] = {};
          }
          keysToUpdate[key][language] = '';
        }
      })
    });
  });
}

async function getRemoteKeys (config = {}) {
  const {
    projectId,
    platform,
  } = _context;

  const loadMore = async (page = 1) => await _lokalise.keys.list({
    project_id: projectId,
    filter_platforms: platform,
    page,
    limit: 500,
    ...config
  });

  let keys = [];

  let newKeys;

  for (let page = 1; !newKeys || newKeys.hasNextPage(); page++) {
    newKeys = await loadMore(page);
    keys = keys.concat(newKeys.items);
  }

  if (config.filter_keys) {
    keys = keys.filter(key => config.filter_keys.includes(key.key_name[platform]))
  }

  return keys;
}

function buildLokaliseCreateKeysRequest (toCreate) {
  console.log('Keys to push:');
  const uploadKeys = [];
  const filename = _context.useFilepath === 'true' ? path.join(_context.rawDirectory, _context.filename) : _context.filename;
  Object.keys(toCreate).forEach(key => {
    console.log('    ' + key);
    const lokaliseKey = {
      key_name: key,
      platforms: [_context.platform],
      translations: [],
      filenames: {
        [_context.platform]: _context.debugFilename || filename
      }
    };
    if (_context.ref) {
      lokaliseKey.tags = [_context.ref];
    }
    Object.keys(toCreate[key]).forEach(lang => {
      console.log(`        ${lang}: ${toCreate[key][lang]}`);
      lokaliseKey.translations.push({
        language_iso: lang,
        translation: toCreate[key][lang]
      });
    });
    uploadKeys.push(lokaliseKey);
  });
  return uploadKeys;
}

function normalizeKey (key) {
  return _context.format === 'json' ? key.split('/').join('::') : key;
}
