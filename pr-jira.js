const core = require('@actions/core');
const github = require('@actions/github');
const { createOAuthUserAuth } = require("@octokit/auth-oauth-user");
const jiraRegex = new RegExp(/((?!([A-Z0-9a-z]{1,10})-?$)[A-Z]{1}[A-Z0-9]+-\d+)/g);
const ticketPattern = new RegExp('([A-Z]+-[0-9]+)', 'g');
const superAgent = require('superagent');
const unique = require('lodash.uniqwith');
const isEqual = require('lodash.isequal');
const octokit = github.getOctokit({
  authStrategy: createOAuthUserAuth,
  auth: {
    clientId: core.getInput("OPENID_CLIENT_ID"),
    clientSecret: core.getInput("OPENID_CLIENT_SECRET"),
    code: "code123",
  },
});

async function gitPrComments(repo, PR) {
  const comments = await octokit.issues.listComments({
    owner: process.env.GITHUB_ORG || core.getInput('repo-owner'),
    repo: repo,
    issue_number: PR,
  });

  var commentTickets = [];
  if (comments.data && comments.data.length > 0) {
    value = comments.data[comments.data.length - 1].body;
    tickets = comments.data[comments.data.length - 1].body.toUpperCase().match(ticketPattern);
    if (tickets) {
      tickets.forEach(jiraTicket => {
        if (comments.data[comments.data.length - 1].user.login !== 'github-actions[bot]') {
          commentTickets.push(jiraTicket);
        }
      });
    }
  }

  return commentTickets;
}

function removeDuplicates(tickets) {
  return tickets.filter((obj, pos, arr) => {
    return arr.map(mapObj => mapObj).indexOf(obj) === pos;
  });
}

async function getAllTickets(repo, prNumber, prTitle, prBody, prHeadBranch) {
  ticketsFound = [];
  prTickets = prTitle.toUpperCase().match(ticketPattern);
  bodyTickets = prBody.toUpperCase().match(ticketPattern);
  branchTickets = prHeadBranch.toUpperCase().match(ticketPattern);
  commentTickets = await gitPrComments(repo, prNumber, process.env.GITHUB_ORG || core.getInput('repo-owner'));
  if (prTickets) {
    console.log('ticket found in pr title');
    ticketsFound = ticketsFound.concat(prTickets);
  }
  if (bodyTickets) {
    console.log('ticket found in pr body');
    ticketsFound = ticketsFound.concat(bodyTickets);
  }
  if (branchTickets) {
    console.log('ticket found in pr branch name');
    ticketsFound = ticketsFound.concat(branchTickets);
  }
  if (commentTickets) {
    console.log('ticket found in pr comment');
    ticketsFound = ticketsFound.concat(commentTickets);
  }

  return removeDuplicates(ticketsFound);
}

function newPrComment(repo, number, body) {
  return octokit.issues.createComment({
    owner: process.env.GITHUB_ORG || core.getInput('repo-owner'),
    repo: repo,
    issue_number: number,
    body: body,
  });
}

function validateJiraRequest(jiraIssue) {
  return new Promise((resolve, reject) => {
    var [projectId, ticket] = jiraIssue.split('-');
    var qstring = JSON.stringify({
      jql: `project=${projectId} AND issue=${jiraIssue}`,
    });

    return superAgent
      .post(process.env.JIRA_ENDPOINT || `${core.getInput('jira-endpoint')}search/`)
      .auth(
        process.env.JIRA_USER || core.getInput('jira-user'),
        process.env.JIRA_API_TOKEN || core.getInput('jira-api-token'),
      )
      .set('Content-Type', 'application/json')
      .send(qstring)
      .end((err, res) => {
        if (err || res.statusCode !== 200) {
          reject(err);
        } else {
          ticket = res.body;
          if (ticket.total === 0) {
            reject(`jira issue ${jiraIssue} not found`);
          } else if (ticket.issues[0].fields.status.name.indexOf('Closed') > -1) {
            reject('Closed jira ticket: ' + jiraIssue + ' Create a new Jira ticket');
            // } else if (ticket.issues[0].fields.status.name.indexOf('Deployed') > -1) {
            //   reject('Jira ticket in Deployed state: ' + jiraIssue + ' Create a new Jira ticket');
          } else if (ticket.issues[0].fields.status.name.indexOf('Done') > -1) {
            reject('Jira ticket in Done state: ' + jiraIssue + ' Create a new Jira ticket');
          } else {
            resolve(ticket);
          }
        }
      });
  }).catch(err => {
    throw err;
  });
}

async function getJiraTicket(jiraProject, jiraIssue) {
  return new Promise((resolve, reject) => {
    return superAgent
      .post(process.env.JIRA_ENDPOINT || `${core.getInput('jira-endpoint')}search/`)
      .auth(
        process.env.JIRA_USER || core.getInput('jira-user'),
        process.env.JIRA_API_TOKEN || core.getInput('jira-api-token'),
      )
      .set('Content-Type', 'application/json')
      .send({ jql: `project = ${jiraProject} AND issue=${jiraIssue}` })
      .end((err, res) => {
        if (err || res.statusCode !== 200) {
          reject(err);
        } else {
          resolve(res.body);
        }
      });
  });
}

function buildJiraInfo(ticket, ticketContents) {
  let jiraLines = [];
  ticketContents.issues.forEach(issue => {
    jiraLines.push(`## [${ticket}](https://vivintsolar.atlassian.net/browse/${ticket})`);
    issue.fields.fixVersions.forEach(version => {
      jiraLines.push(`Jira Version: ${version.name}`);
      // jiraReleaseName = version.releaseDate;
      // jiraVersionName = version.name;
    });
    let descriptionLines;
    if (issue.fields.description) {
      descriptionLines = issue.fields.description.split('\r\n');
    } else {
      descriptionLines = issue.fields.summary.split('\r\n');
    }
    const newLines = descriptionLines.map(line => {
      if (line.length !== 0) {
        if (line.startsWith('[http')) {
          line = line.replace(/\[/g, '').replace(/\]/, '');
        }
        return `> ${line}`;
      }

      return line;
    });
    jiraLines = jiraLines.concat(newLines);
  });

  jiraLines.push('---');
  return jiraLines;
}

function addJiraLabels(repo, issueNum, pr) {
  return new Promise((resolve, reject) => {
    superAgent
      .put(`${core.getInput('jira-endpoint')}issue/${issueNum}`)
      .auth(
        process.env.JIRA_USER || core.getInput('jira-user'),
        process.env.JIRA_API_TOKEN || core.getInput('jira-api-token'),
      )
      .set('Content-Type', 'application/json')
      .send({ update: { labels: [{ add: repo + ':' + pr }] } })
      .end((err, res) => {
        if (err || res.statusCode !== 204) {
          reject(err);
        } else {
          resolve(res);
        }
      });
  });
}

function updatePRBody(repo, prNumber, newBody) {
  return octokit.pulls.update({
    owner: process.env.GITHUB_ORG || core.getInput('repo-owner'),
    repo: repo,
    pull_number: prNumber,
    body: newBody,
  });
}

async function getMasterRef(repo, ref) {
  try {
    const results = await octokit.git.getRef({
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
    const results = await octokit.repos.createCommitStatus({
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

async function evalJiraInfoInPR(repo, prNumber, prBody, prTitle, headRef) {
  let regexTickets = [];
  let uniqueTickets = [];
  let ticketMarkers = [];
  let validatedTickets = false;
  const bodyLines = prBody.split('\r\n');

  regexTickets = await getAllTickets(repo, prNumber, prTitle, prBody, headRef);
  uniqueTickets = unique(regexTickets, isEqual);
  const realTickets = await Promise.all(
    uniqueTickets.map(async ticket => {
      try {
        const [projectId] = ticket.split('-');
        await getJiraTicket(projectId, ticket);

        return ticket;
      } catch (err) {
        return console.log(err.message);
      }
    }),
  );
  const validTickets = realTickets.filter(ticket => {
    return ticket !== undefined && !ticket.includes(`PR-${prNumber}`) && ticket.match(jiraRegex);
  });
  let errorList = [];
  const cleanTickets = await Promise.all(
    validTickets.map(async ticket => {
      try {
        const ticketInfo = await validateJiraRequest(ticket);
        validatedTickets = true;
        return buildJiraInfo(ticket, ticketInfo);
      } catch (err) {
        console.log(err);
        let ticketNum = err.match(jiraRegex);
        errorList.push(err);
        errorList.push('Create a comment with a valid Jira ticket');
        await newPrComment(repo, prNumber, `${errorList.join('\r\n')}`);
      }
    }),
  );
  ticketStartIndex = bodyLines.findIndex(line => {
    return line.match(/Related Jira tickets/g);
  });
  endTicketIndex = bodyLines.findIndex(line => {
    return line.match(/end_jira_tickets/g);
  });
  if (ticketStartIndex !== -1 && endTicketIndex !== -1) {
    bodyLines.splice(ticketStartIndex, endTicketIndex + 1);
  }

  ticketMarkers.push('## Related Jira tickets');
  ticketMarkers.push('[end_jira_tickets]:>>>');
  ticketStartIndex = 0;
  endTicketIndex = 1;

  bodyLines.splice.apply(bodyLines, [ticketStartIndex, 0].concat(ticketMarkers));

  bodyLines.splice.apply(bodyLines, [ticketStartIndex + 1, 0].concat(cleanTickets.flat()));
  if (realTickets.length === 0) {
    await newPrComment(repo, prNumber, 'No valid Jira tickets specified! Create a comment with a valid Jira ticket');
  }
  if (realTickets.length > 1) {
    await newPrComment(repo, prNumber, 'More than 1 Jira ticket specified, divide the work between 2 pull requests?');
  }
  // await Promise.all(uniqueTickets.map(async(ticket) => {
  //   await addJiraLabels(repo, ticket, prNumber);
  // }));
  const reqStatus = {
    context: core.getInput('jira-required-status') || 'Jira Validation',
    description: 'Valid Jira ticket specified in PR',
    state: validatedTickets ? 'success' : 'failure',
  };
  await newGitHubStatusBranch(repo, headRef, reqStatus);
  if (validatedTickets) {
    const newBody = bodyLines.join('\r\n');
    await updatePRBody(repo, prNumber, newBody);
  }

  return 'PR updated';
}

(async () => {
  try {
    // const payload = JSON.stringify(github.context.payload, undefined, 2);
    // console.log(payload);

    if (github.context.payload.action === 'created' && github.context.payload.comment !== undefined) {
      repoName = github.context.payload.repository.name;
      prNumber = github.context.payload.issue.number;
      prBody = github.context.payload.issue.body;
      prTitle = github.context.payload.issue.title;
      pr = await github.pulls.get({
        owner: core.getInput('repo-owner'),
        repo: repoName,
        pull_number: prNumber,
      });
      headRef = pr.data.head.ref;
    } else {
      repoName = github.context.payload.repository.name;
      prNumber = github.context.payload.pull_request.number;
      prBody = github.context.payload.pull_request.body;
      prTitle = github.context.payload.pull_request.title;
      headRef = github.context.payload.pull_request.head.ref;
    }

    await evalJiraInfoInPR(repoName, prNumber, prBody, prTitle, headRef);

    // const res = await evalJiraInfoInPR(
    //   'gh-build-tools',
    //   '48',
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
    //   'badge_server_endpoint',
    // );
    console.log(`event = ${github.context.payload.action}`);
    // console.log(`pr base label = ${github.context.payload.pull_request.base.label}`);
  } catch (error) {
    core.setFailed(error.message);
  }
})();
