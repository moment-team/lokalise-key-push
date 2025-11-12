const path = require('path');
const fs = require('fs');
const core = require('./core');
const { LokaliseApi } = require('@lokalise/node-api');
const gitlabVcs = require('./vcs/gitlab');

(async () => {
  try {
    // Canonical, unambiguous inputs (set via GitLab CI/CD variables)
    const apiKey = process.env.LOKALISE_API_TOKEN;
    const projectId = process.env.LOKALISE_PROJECT_ID;
    const directory = process.env.LKP_DIRECTORY;
    const format = process.env.LKP_FORMAT; // json | properties
    const platform = process.env.LKP_PLATFORM; // ios | android | web etc.
    const filename = process.env.LKP_FILENAME; // pattern with %LANG_ISO%
    const useFilepath = process.env.LKP_USE_FILEPATH; // 'true' | 'false'

    // Refs: use explicit LKP_* when provided; fall back to CI sensible defaults
    const ref = process.env.LKP_REF || process.env.CI_COMMIT_SHA; // prefer explicit ref; else current commit SHA
    const targetRef = process.env.LKP_TARGET_REF || process.env.CI_MERGE_REQUEST_TARGET_BRANCH_NAME; // MR base when in MR

    // GitLab context
    const glProjectId = process.env.CI_PROJECT_ID;
    const privateToken = process.env.GITLAB_PRIVATE_TOKEN; // optional, CI_JOB_TOKEN is usually enough on public gitlab
    const jobToken = process.env.CI_JOB_TOKEN;
    const apiBase = process.env.CI_API_V4_URL; // provided in GitLab runners

    if (!apiKey) throw new Error('Missing Lokalise API token (LOKALISE_API_TOKEN)');
    if (!projectId) throw new Error('Missing Lokalise project id (LOKALISE_PROJECT_ID)');
    if (!directory) throw new Error('Missing directory (LKP_DIRECTORY)');
    if (!format) throw new Error('Missing format (LKP_FORMAT)');
    if (!platform) throw new Error('Missing platform (LKP_PLATFORM)');
    if (!filename) throw new Error('Missing filename pattern (LKP_FILENAME)');
    if (!ref) throw new Error('Missing ref (LKP_REF or CI_COMMIT_SHA)');
    if (!targetRef) throw new Error('Missing target ref (LKP_TARGET_REF or CI_MERGE_REQUEST_TARGET_BRANCH_NAME)');

    const vcs = gitlabVcs({ token: privateToken, jobToken, projectId: glProjectId, apiBase });

    const result = await core({
      apiKey,
      projectId,
      rawDirectory: directory,
      directory: path.join(process.env.CI_PROJECT_DIR || process.cwd(), directory),
      format,
      platform,
      filename,
      useFilepath,
      ref,
      targetRef,
      repoToken: privateToken || jobToken
    }, {
      LokaliseApi,
      fs,
      vcs
    });

    console.log('Result:', JSON.stringify(result));
    console.log('Finished');
  } catch (error) {
    console.error('Failed:', error && error.message ? error.message : error);
    process.exitCode = 1;
  }
})();
