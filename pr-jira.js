// import jpkg from 'jira.js';
const jpkg = require('jira.js');
// const { Version2Client } = jpkg;
// import * as core from '@actions/core';
const core = require('@actions/core');
// import github from '@actions/github';
const github = require('@actions/github');
// const { getOctokit } = github;
// import ghpkg from '@octokit/graphql';
// const ghpkg = require('@octokit/graphql');
// const { graphql } = ghpkg;
const jiraRegex = new RegExp(/((?!([A-Z0-9a-z]{1,10})-?$)[A-Z]{1}[A-Z0-9]+-\d+)/g);
const ticketPattern = new RegExp('([A-Z]+-[0-9]+)', 'g');
// import { uniq, isEqual } from 'lodash';
const unique = require('lodash.uniqwith');
const isEqual = require('lodash.isequal');

let testMode = false;
const searchBranch = process.env.SEARCH_BRANCH || false;
const searchPrBody = process.env.SEARCH_BODY || false;
const searchTitle = process.env.SEARCH_TITLE || false;
const searchComments = process.env.SEARCH_COMMENTS || false;

const octokit = github.getOctokit(process.env.GH_TOKEN || core.getInput('github-token'));

let jiraClient = {};

const allTicketsQuery = `query($repo: String!, $prNumber: Int!, $owner: String!) {
  repository(owner: $owner, name: $repo) {
    name
    pullRequest(number: $prNumber){
      id
      title
      body
      headRef {
        name
      }
    }   
  }
}`;

const prCommentsQuery = `query($repo: String!, $prNumber: Int!, $owner: String!, $nodeCount: Int!) {
  repository(owner: $owner, name: $repo) {
    name
    pullRequest(number: $prNumber){
      comments(last: $nodeCount) {
        edges {
          node {
            body
            author {
              login
            }
          }
        }
      }   
      headRef {
        name
      }
    }   
  }
}`;

const createCommentMutation = `mutation($prId: ID!, $commentBody: String!) {
  addComment(input:{subjectId: $prId, body: $commentBody}) {
    commentEdge {
      node {
        createdAt
        body
      } 
    }
    subject {
      id
    }
  }
}`;

async function getPrStuff(owner, repo, prNum) {
  const prInfo = await octokit.graphql(allTicketsQuery, {
    prNumber: prNum,
    owner: owner,
    repo: repo,
    headers: {
      authorization: `token ${process.env.GH_TOKEN || core.getInput('github-token')}`
    }
  });

  return prInfo.repository.pullRequest;
}

async function createPrComment(owner, repo, prNum, prId, commentBodyText) {
  // const prInfo = await getPrStuff(owner, repo, prNum);

  return await octokit.graphql(createCommentMutation, {
    prId: prId,
    commentBody: commentBodyText,
    owner: owner,
    repo: repo,
    headers: {
      authorization: `token ${process.env.GH_TOKEN || core.getInput('github-token')}`
    }
  });
}

function getPrTickets(nodes) {
  const vals = nodes.map((node) => {
    let tickets = node.node.body.toUpperCase().match(ticketPattern);
    if (node.node.author.login !== 'github-actions' && tickets) {
      return tickets.join(',');
    }
  })

  return vals.filter((val) => {
    return val;
  })
}

function removeDuplicates(tickets) {
  return tickets.filter((obj, pos, arr) => {
    return arr.map(mapObj => mapObj).indexOf(obj) === pos;
  });
}

async function getAllTickets(owner, repo, prNumber, prBody, prTitle, headRef ) {
  let ticketsFound = [];

  let ghToken;
  if (process.env.GH_TOKEN) {
    ghToken = `token ${process.env.GH_TOKEN}`;
  } else {
    ghToken = `token ${core.getInput('github-token')}`;
  }
  // const prData = await getPrStuff(owner, repo, prNumber);

  const prComments = await octokit.graphql(
    prCommentsQuery, {
      owner: owner,
      repo: repo,
      prNumber: prNumber,
      nodeCount: 100,
      headers: {
        authorization:  ghToken
      }
    }
  );

  if (core.getInput && core.getInput('ticket-search-title') || searchTitle === 'true') {
    let prTickets = prTitle.toUpperCase().match(ticketPattern);
    if (prTickets) {
      console.log('ticket found in pr title');
      ticketsFound = ticketsFound.concat(prTickets);
    }
  }
  if (core.getInput && core.getInput('ticket-search-pr-body') || searchPrBody === 'true') {
    let bodyTickets = prBody.toUpperCase().match(ticketPattern);
    if (bodyTickets) {
      console.log('ticket found in pr body');
      ticketsFound = ticketsFound.concat(bodyTickets);
    }
  }
  if (core.getInput && core.getInput('ticket-search-branch') || searchBranch === 'true') {
    let branchTickets = headRef.toUpperCase().match(ticketPattern);
    if (branchTickets) {
      console.log('ticket found in pr branch name');
      ticketsFound = ticketsFound.concat(branchTickets);
    }
  }
  if (core.getInput && core.getInput('ticket-search-comments') || searchComments === 'true') {
    if (prComments.repository.pullRequest.comments) {
      console.log('ticket found in pr comment');
      let commentTickets = getPrTickets(prComments.repository.pullRequest.comments.edges);
      ticketsFound = ticketsFound.concat(commentTickets);
    }
  }

  return removeDuplicates(ticketsFound);
}

async function jiraValidationRequest(jiraIssue) {
  return new Promise(async(resolve, reject) => {
    let [projectId, ticket] = jiraIssue.key.split('-');
    let qstring = {
      jql: `project=${projectId} AND issue=${jiraIssue.key}`,
    };

    try {
      const results = await jiraClient.issueSearch.searchForIssuesUsingJql(qstring);
      ticket = results.issues;
      if (ticket.length === 0) {
        reject(`jira issue ${jiraIssue} not found`);
      } else if (ticket[0].fields.status.name.indexOf('Closed') > -1) {
        reject('Closed jira ticket: ' + jiraIssue.key + ' Create a new Jira ticket');
        // } else if (ticket.issues[0].fields.status.name.indexOf('Deployed') > -1) {
        //   reject('Jira ticket in Deployed state: ' + jiraIssue + ' Create a new Jira ticket');
      } else if (ticket[0].fields.status.name.indexOf('Done') > -1) {
        reject('Jira ticket in Done state: ' + jiraIssue.key + ' Create a new Jira ticket');
      } else {
        resolve(ticket[0]);
      }
    } catch(err) {
      console.log(err.message);
    }
  }).catch(err => {
    throw err;
  });
}

function validateProjectId(projectId) {
  if (process.env.PROJECT_IDS || core.getInput('valid-jira-project-ids')) {
    const validIds = process.env.PROJECT_IDS || core.getInput && core.getInput('valid-jira-project-ids');
    if (validIds.split(',').includes(projectId)) {
      return true
    }
    throw new Error( `Invalid Jira project Id, ${projectId} is not included in valid-jira-project-ids ${core.getInput && core.getInput('valid-jira-project-ids') || process.env.PROJECT_IDS}`);
  }
  return true;
}

async function findJiraTicket(jiraProject, jiraIssue) {
  return await jiraClient.issueSearch.searchForIssuesUsingJql({ jql: `project=${jiraProject} AND issue=${jiraIssue}` });
}

async function getMasterRef(owner, repo, ref) {
  try {
    const results = await octokit.rest.git.getRef({
      owner: owner,
      repo: repo,
      ref: ref,
    });

    return results.data;
  } catch (err) {
    console.log(err.message);
  }
}

async function newGitHubStatusBranch(owner, repo, branch, status) {
  try {
    const refObject = await getMasterRef(owner, repo, `heads/${branch}`);
    const results = await octokit.rest.repos.createCommitStatus({
      owner: owner,
      repo: repo,
      sha: refObject.object.sha,
      state: status.state,
      target_url: status.target_url,
      description: status.description,
      context: status.context,
    });

    console.log('Github status named ' + status.context + ' was updated with ' + status.state);
    return results.data;
  } catch (err) {
    console.log(err.message);
  }
}

async function evalJiraInfoInPR(owner, repo, prNumber, prBody, prTitle, headRef, prId) {
  let validatedTickets = false;

  const regexTickets = await getAllTickets(owner, repo, prNumber, prBody, prTitle, headRef, prId);
  const uniqueTickets = unique(regexTickets, isEqual);
  // uniqueTickets = ['DS-3848', 'DS-3884'];
  let errorList = [];
  let realTickets = await Promise.all(
    uniqueTickets.map(async ticket => {
      const [projectId] = ticket.split('-');
      try {
        validateProjectId(projectId);
        const results = await findJiraTicket(projectId, ticket);

        return results.issues[0];
      } catch (err) {
        console.log(err.message);
        errorList.push(err.message);
        errorList.push(`Error accessing Jira ticket ${ticket}`);
        if (err.response && err.response.status === 400) {
          errorList.push(`Is Jira project with ID ${projectId} visible for search?`);
        }
        await createPrComment(owner, repo, prNumber, prId,`${errorList.join('\r\n')}`);
        return undefined;
      }
    })
  );
//  now filter out tickets with issues
  realTickets = realTickets.filter((ticket) => {
    return ticket;
  })

  const validTickets = realTickets.filter(ticket => {
    return ticket !== undefined && !ticket.key.includes(`PR-${prNumber}`) && ticket.key.match(jiraRegex);
  });
  await Promise.all(
    validTickets.map(async ticket => {
      try {
        const ticketInfo = await jiraValidationRequest(ticket);
        validatedTickets = true;
        return ticketInfo;
      } catch (err) {
        console.log(err);
        // let ticketNum = err.match(jiraRegex);
        errorList.push(err);
        errorList.push('Valid Jira ticket needed (edit title, pr body, or add a comment with valid Jira ticket');
        await createPrComment(owner, repo, prNumber, `${errorList.join('\r\n')}`);
        core.setFailed(errorList.join('\r\n'));
        process.exit(1);
      }
    }),
  );

  if (realTickets.length === 0) {
    await createPrComment(owner, repo, prNumber, 'No valid Jira tickets specified!');
    core.setFailed('No valid Jira tickets specified!');
    process.exit(1);
  }

  if (realTickets.length > 1) {
    await createPrComment(owner, repo, prNumber, 'More than 1 Jira ticket specified, divide the work between 2 pull requests?');
    core.setFailed('More than 1 Jira ticket specified, divide the work between 2 pull requests?');
    process.exit(1);
  }

  if (core.getInput && core.getInput('jira-required-status') || process.env.REQUIRED_STATUS === 'true') {
    const reqStatus = {
      context: core.getInput('jira-required-status') || process.env.REQUIRED_STATUS_CONTEXT,
      description: core.getInput('Valid Jira ticket specified in PR') || process.env.REQ_STATUS_DESCRIPTION,
      state: validatedTickets ? 'success' : 'failure'
    };
    await newGitHubStatusBranch(owner, repo, headRef, reqStatus);
  }

  process.exit(0);
}

(async () => {
  let tokenValue = '';
  if (process.env.BLUE_JIRA_AUTH || core.getInput && core.getInput('jira-auth')) {
    if (core.getInput && core.getInput('jira-auth')) {
      tokenValue = core.getInput('jira-auth')
    } else if (process.env.BLUE_JIRA_AUTH) {
      tokenValue = process.env.BLUE_JIRA_AUTH;
    }
  }

  const [email, apiToken] = tokenValue.split(':');
  try {
    jiraClient = await new jpkg.Version2Client({
      host: process.env.JIRA_HOST || core.getInput && core.getInput('jira-host'), //'https://sunrun.jira.com',
      authentication: {
        basic: {
          email: email,
          apiToken: apiToken
        }
      }
    });
    const payload = JSON.stringify(github.context.payload, undefined, 2);
    console.log(payload);

    let repoName;
    let repoOwner;
    let prNumber;
    let prBody;
    let prTitle;
    let headRef;

    repoName = github.context.payload.repository.name;
    repoOwner = github.context.payload.organization.login;
    if (github.context.payload.pull_request) {
      prBody = github.context.payload.pull_request.body;
      prTitle = github.context.payload.pull_request.title;
      headRef = github.context.payload.pull_request.head.ref
      prNumber = github.context.payload.pull_request.number;
      prId = github.context.payload.pull_request.id;
    } else if (github.context.payload.issue.number) {
      prNumber = github.context.payload.issue.number;
      prData = getPrStuff(repoOwner, repoName, prNumber);
      prBody = prData.body;
      prTitle = prData.title;
      headRef = prData.headRef.name;
      prId = prData.id
    }

    // console.log(`${repoName} ${repoOwner} ${headRef}`);
    await evalJiraInfoInPR(repoOwner, repoName, prNumber, prBody, prTitle, headRef, prId);

    // testMode = true;
  } catch (error) {
    core.setFailed(error.message);
  }
})();
