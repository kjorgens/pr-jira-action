import jpkg from 'jira.js';
const { Version2Client } = jpkg;
import * as core from '@actions/core';
import actionGhPkg from '@actions/github';
const { getOctokit } = actionGhPkg;
import ghpkg from '@octokit/graphql';
const { graphql } = ghpkg;
const jiraRegex = new RegExp(/((?!([A-Z0-9a-z]{1,10})-?$)[A-Z]{1}[A-Z0-9]+-\d+)/g);
const ticketPattern = new RegExp('([A-Z]+-[0-9]+)', 'g');
import unique from 'lodash.uniqwith';
import isEqual from 'lodash.isequal';

const octokit = getOctokit(process.env.GH_TOKEN || core.getInput('github_token'));

let jiraClient = {};

const allTicketsQuery = `query($repo: String!, $prNumber: Int!, $owner: String!) {
  repository(owner: $owner, name: $repo) {
    name
    pullRequest(number: $prNumber){
      headRef {
        name
      }
      title
      bodyText
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

const getPRIdQuery = `query($repo: String!, $prNumber: Int!, $owner: String!) {
  repository(owner: $owner, name: $repo) {
    name
    pullRequest(number: $prNumber) {
      id
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

async function createPrComment(owner, repo, prNum, commentBodyText) {
  const prInfo = await graphql(getPRIdQuery, {
    prNumber: prNum,
    owner: owner,
    repo: repo,
    headers: {
      authorization: `token ${core.getInput('github_token')}`
    }
  });

  return await graphql(createCommentMutation, {
    prId: prInfo.repository.pullRequest.id,
    commentBody: commentBodyText,
    owner: owner,
    repo: repo,
    headers: {
      authorization: `token ${core.getInput('github_token')}`
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

async function getAllTickets(owner, repo, prNumber) {
  let ticketsFound = [];

  const prData = await graphql(
    allTicketsQuery, {
      prNumber: prNumber,
      owner: owner,
      repo: repo,
      headers: {
        authorization: `token ${core.getInput('github_token')}`
      }
    }
  );

  const prComments = await graphql(
    prCommentsQuery, {
      owner: owner,
      repo: repo,
      prNumber: prNumber,
      nodeCount: 100,
      headers: {
        authorization: `token ${core.getInput('github_token')}`
      }
    }
  );

  if (process.env.SEARCH_TITLE ===  'true' || core.getInput('ticket-search-title')) {
    let prTickets = prData.repository.pullRequest.title.toUpperCase().match(ticketPattern);
    if (prTickets) {
      console.log('ticket found in pr title');
      ticketsFound = ticketsFound.concat(prTickets);
    }
  }
  if (process.env.SEARCH_BODY === 'true' || core.getInput('ticket-search-pr-body')) {
    let bodyTickets = prData.repository.pullRequest.bodyText.toUpperCase().match(ticketPattern);
    if (bodyTickets) {
      console.log('ticket found in pr body');
      ticketsFound = ticketsFound.concat(bodyTickets);
    }
  }
  if (process.env.SEARCH_BRANCH === 'true' || core.getInput('ticket-search-branch')) {
    let branchTickets = prData.repository.pullRequest.headRef.name.toUpperCase().match(ticketPattern);
    if (branchTickets) {
      console.log('ticket found in pr branch name');
      ticketsFound = ticketsFound.concat(branchTickets);
    }
  }
  if (process.env.SEARCH_COMMENTS === 'true' || core.getInput('ticket-search-comments')) {
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
    var [projectId, ticket] = jiraIssue.key.split('-');
    var qstring = {
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

async function findJiraTicket(jiraProject, jiraIssue) {
  return await jiraClient.issueSearch.searchForIssuesUsingJql({ jql: `project=${jiraProject} AND issue=${jiraIssue}` });
}

async function getMasterRef(repo, ref) {
  try {
    const results = await octokit.rest.git.getRef({
      owner: process.env.GITHUB_ORG || core.getInput('repo-owner'),
      repo: repo,
      ref: ref,
    });

    return results.data;
  } catch (err) {
    console.log(err.message);
  }
}

async function newGitHubStatusBranch(repo, branch, status) {
  try {
    const refObject = await getMasterRef(repo, `heads/${branch}`);
    const results = await octokit.rest.repos.createCommitStatus({
      owner: process.env.GITHUB_ORG || core.getInput('repo-owner'),
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

async function evalJiraInfoInPR(owner, repo, prNumber, prBody, prTitle, headRef) {
  let validatedTickets = false;

  const regexTickets = await getAllTickets(owner, repo, prNumber, prTitle, prBody, headRef);
  const uniqueTickets = unique(regexTickets, isEqual);
  // uniqueTickets = ['DS-3848', 'DS-3884'];
  let errorList = [];
  let realTickets = await Promise.all(
    uniqueTickets.map(async ticket => {
      const [projectId] = ticket.split('-');
      try {
        const results = await findJiraTicket(projectId, ticket);

        return results.issues[0];
      } catch (err) {
        console.log(err.message);
        errorList.push(err.message);
        errorList.push(`Error accessing Jira ticket ${ticket}`);
        if (err.response.status === 400) {
          errorList.push(`Is Jira project with ID ${projectId} visible for search?`);
        }
        await createPrComment(owner, repo, prNumber, `${errorList.join('\r\n')}`);
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
  const cleanTickets = await Promise.all(
    validTickets.map(async ticket => {
      try {
        const ticketInfo = await jiraValidationRequest(ticket);
        validatedTickets = true;
        return ticketInfo;
      } catch (err) {
        console.log(err);
        let ticketNum = err.match(jiraRegex);
        errorList.push(err);
        errorList.push('Valid Jira ticket needed (edit title, pr body, or add a comment with valid Jira ticket');
        await createPrComment(owner, repo, prNumber, `${errorList.join('\r\n')}`);
      }
    }),
  );

  if (realTickets.length === 0) {
    await createPrComment(owner, repo, prNumber, 'No valid Jira tickets specified! Create a comment with a valid Jira ticket');
  }

  if (realTickets.length > 1) {
    await createPrComment(owner, repo, prNumber, 'More than 1 Jira ticket specified, divide the work between 2 pull requests?');
  }

  if (process.env.REQUIRED_STATUS === 'true' || core.getInput('jira-required-status')) {
    const reqStatus = {
      context: process.env.REQUIRED_STATUS_CONTEXT || core.getInput('jira-required-status'),
      description: process.env.REQ_STATUS_DESCRIPTION || core.getInput('Valid Jira ticket specified in PR'),
      state: validatedTickets ? 'success' : 'failure'
    };
    await newGitHubStatusBranch(repo, headRef, reqStatus);
  }

  return 'PR updated';
}

(async () => {
  const stuff = process.env.BLUE_JIRA_AUTH.split(':');
  const [email, apiToken] = stuff;
  try {
    jiraClient = await new Version2Client({
      host: process.env.JIRA_HOST || core.getInput('jira-host'), //'https://sunrun.jira.com',
      authentication: {
        basic: {
          email: email,
          apiToken: apiToken
        }
      }
    });
    const payload = JSON.stringify(github.context.payload, undefined, 2);
    console.log(payload);

    let repoName = '';
    let repoOwner = '';
    let prNumber = '';
    let prBody = '';
    let prTitle = '';
    let pr = {};
    let headRef = '';

    if (github.context.payload.action === 'created' && github.context.payload.comment !== undefined) {
      repoName = github.context.payload.repository.name;
      repoOwner = github.context.payload.repository_owner;
      prNumber = github.context.payload.issue.number;
      prBody = github.context.payload.issue.body;
      prTitle = github.context.payload.issue.title;
      pr = await octokit.pulls.get({
        owner: core.getInput('repo-owner'),
        repo: repoName,
        pull_number: prNumber,
      });
      headRef = pr.data.head.ref;
    } else {
      repoName = github.context.payload.repository.name;
      repoOwner = github.context.payload.repository_owner;
      prNumber = github.context.payload.pull_request.number;
      prBody = github.context.payload.pull_request.body;
      prTitle = github.context.payload.pull_request.title;
      headRef = github.context.payload.pull_request.head.ref;
    }

    await evalJiraInfoInPR(repoOwner, repoName, prNumber, prBody, prTitle, headRef);

    // const res = await evalJiraInfoInPR(
    //   'vivintsolar',
    //   'gh-build-tools',
    //   52,
    //   //'## Related Jira tickets\r\n## [CIE-1139](https://vivintsolar.atlassian.net/browse/CIE-1139)\r\n> Convert 1 early adopter repo over to ghActions\r\n---\n\r\n\r\n\r\n<!---[![Start Tests](https://devdash.vivintsolar.com/api/badges/TestingBadge.svg?badgeAction=updateBadge&badgeText=Start%20build&status=Jenkins&color=orange)](https://devdash.vivintsolar.com/api/auth/okta?redirect_to=https://devdash.vivintsolar.com/api/executeJenkinsJob?jenkinsJob=gh-build-tools&jenkinsURL=https://build2.vivintsolar.com/job/gh-build-tools/job/-PR-TBD-/)--->\r\n\r\n## Checklist ([review](https://vivintsolar.atlassian.net/wiki/spaces/HE/pages/616693761/Git+Commit+Standards) and check all)\r\n\r\n- [ ] Rebased on the latest master (`git pull --rebase origin master`)\r\n- [ ] Commit messages follow [standards](https://kb.vstg.io/best-practices/git)\r\n- [ ] Atomic commits\r\n- [ ] Tests adjusted to address changes\r\n- [ ] Analytic events added/updated following the [conventions](../analytics/readme.md)\r\n  - [ ] Verified in the [HEA-Development](https://analytics.amplitude.com/vslr/activity) lane\r\n- [ ] Version commit added (if applicable)\r\n- [ ] Documentation\r\n  - [ ] [Release, Test, Device plans](./solar/) updated\r\n- [ ] Reviewed by author\r\n- [ ] Ready for review\r\n\r\n[currentUnitTestCount]: 7\r\n[currentIntegrationTestCount]: 3',
    //   '[CIE-1139](https://vivintsolar.atlassian.net/browse/CIE-1139)\n' +
    //     '\n' +
    //     '<!---[![Start Tests](https://devdash.vivintsolar.com/api/badges/TestingBadge.svg?badgeAction=updateBadge&badgeText=Start%20build&status=Jenkins&color=orange)](https://devdash.vivintsolar.com/api/auth/okta?redirect_to=https://devdash.vivintsolar.com/api/executeJenkinsJob?jenkinsJob=gh-build-tools&jenkinsURL=https://build2.vivintsolar.com/job/gh-build-tools/job/-PR-TBD-/)--->\n' +
    //     '\n' +
    //     '## Checklist ([review](https://vivintsolar.atlassian.net/wiki/spaces/HE/pages/616693761/Git+Commit+Standards) and check all)\n' +
    //     '\n' +
    //     '- [ ] Rebased on the latest master (`git pull --rebase origin master`)\n' +
    //     '- [ ] Commit messages follow [standards](https://kb.vstg.io/best-practices/git)\n' +
    //     '- [ ] Atomic commits\n' +
    //     '- [ ] Tests adjusted to address changes\n' +
    //     '- [ ] Analytic events added/updated following the [conventions](../analytics/readme.md)\n' +
    //     '  - [ ] Verified in the [HEA-Development](https://analytics.amplitude.com/vslr/activity) lane\n' +
    //     '- [ ] Version commit added (if applicable)\n' +
    //     '- [ ] Documentation\n' +
    //     '  - [ ] [Release, Test, Device plans](./solar/) updated\n' +
    //     '- [ ] Reviewed by author\n' +
    //     '- [ ] Ready for review',
    //   'fix: update template add missing tags',
    //   'deploy_test',
    // );
    // console.log(`event = ${github.context.payload.action}`);
    // console.log(`pr base label = ${github.context.payload.pull_request.base.label}`);
  } catch (error) {
    core.setFailed(error.message);
  }
})();
