const path = require('path');
const fs = require('fs');
const core = require('./core');
const ghCore = require('@actions/core');
const { LokaliseApi } = require('@lokalise/node-api');
const githubVcs = require('./vcs/github');

const apiKey = ghCore.getInput('api-token');
const projectId = ghCore.getInput('project-id');
const directory = ghCore.getInput('directory');
const format = ghCore.getInput('format');
const platform = ghCore.getInput('platform');
const filename = ghCore.getInput('filename');
const useFilepath = ghCore.getInput('use-filepath');
const ref = ghCore.getInput('ref');
const targetRef = ghCore.getInput('target-ref');
const repository = ghCore.getInput('repository');
const repoToken = ghCore.getInput('repo-token');

const vcs = githubVcs({ token: repoToken, repository });

core({
  apiKey,
  projectId,
  rawDirectory: directory,
  directory: path.join(process.env.GITHUB_WORKSPACE, directory),
  format,
  platform,
  filename,
  useFilepath,
  ref,
  targetRef,
  repository,
  repoToken
}, {
  LokaliseApi,
  fs,
  vcs
})
.then((result) => {
  ghCore.setOutput('result', JSON.stringify(result));
})
.then(() => console.log('Finished'))
.catch(error => ghCore.setFailed(error ? error.message : 'Unknown error'))
