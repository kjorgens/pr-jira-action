# Github pr/jira action

This action integrates Jira with Github pull requests.

## About

GitHub Action to integrate Jira tickets with GitHub pull requests. Checks pull request for valid Jira tickets. If a ticket does not exist or is done or closed, a comment is created on the pull request.
![Screenshot](./img/invalid_ticket.png)
Listens for pull request comments that contain a Jira ticket. Adds link and Jira ticket description to the pull request body.
![Screenshot](./img/pr_body_jira.png)
Sets GitHub status to indicate specified Jira tickets are valid.
![Screenshot](./img/jira_valid_status.png)
If more than one Jira ticket is specified, a reminder comment is created.
![Screenshot](./img/two_tickets_remind.png)

---

## Usage
**1. Jira endpoint.**

    https://<yourjira>.atlassian.net/rest/api/2/
**2. Jira User.**

    Jira API user name

**3. Jira API Token**

    Jira API token

**4. Jira Status Context**
  
    GitHub pull request status context for Jira.
    default: Jira Validation
    
**5. GitHub Repo Owner**

    GitHub organization name    

**6. Github Token**

    GitHub api token 

```yaml
name: PR Jira integration

on:
  issue_comment:
    types: [created]
  pull_request:
    types: [opened, synchronize, reopened]

jobs:
  jira_ticket_job:
    runs-on: ubuntu-latest
    name: A job to integrate jira with github
    steps:
      # To use this repository's private action, you must check out the repository
      - name: Checkout
        uses: actions/checkout@v2
      - name: pr jira
        uses: ./dist/index.js
        id: prJira
        with:
          jira-endpoint: 'https://yourjira.atlassian.net/rest/api/2/'
          repo-owner: 'kjorgens'
          repo-token: ${{ secrets.GITHUB_TOKEN }}
          jira-user: ${{ secrets.JIRA_USER }}
          jira-api-token: ${{ secrets.JIRA_API_TOKEN }}
          jira-required-status: 'Jira Validation'
```
