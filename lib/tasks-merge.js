'use strict';

/**
 * Объединяет локальный трекер (Яндекс.Диск) и открытые GitHub Issues
 * в один список в формате задач для чата, list_tasks и мини-приложения.
 */

const tasks = require('./tasks');
const github = require('./github');

const GH_PREFIX = 'gh:';

function issueToTask(issue) {
  const labels = issue.labels || [];
  const urgent = labels.some(l => /urgent|blocker|asap|к\s*ритич/i.test(l));
  return {
    id: issue.id,
    title: issue.title,
    status: 'pending',
    urgent,
    important: true,
    project: `${GH_PREFIX}${issue.repo}`,
    tags: [...labels, 'github'],
    due_date: null,
    notes: null,
    created_at: issue.created_at,
    updated_at: issue.updated_at,
    source: 'github',
    github_url: issue.url,
    github_repo: issue.repo,
    linked_project: issue.project || null
  };
}

function applyFilters(arr, { status, urgent, important, tag } = {}) {
  let f = arr;
  if (status !== undefined) f = f.filter(t => t.status === status);
  if (urgent !== undefined) f = f.filter(t => t.urgent === urgent);
  if (important !== undefined) f = f.filter(t => t.important === important);
  if (tag) f = f.filter(t => t.tags && t.tags.includes(tag));
  return f;
}

async function fetchGithubTasks(options) {
  if (!github.isConfigured()) return [];

  let confProject = null;
  let repoFromPrefix = null;
  if (options.project) {
    const p = String(options.project);
    if (p.startsWith(GH_PREFIX)) {
      repoFromPrefix = p.slice(GH_PREFIX.length);
    } else {
      confProject = p;
    }
  }

  let issues = await github.getAllOpenIssues(confProject);
  if (repoFromPrefix) {
    issues = issues.filter(i => i.repo === repoFromPrefix);
  }
  return issues.map(issueToTask);
}

async function listTasksWithGithub(options = {}) {
  const localOpts = { ...options };
  if (localOpts.project && String(localOpts.project).startsWith(GH_PREFIX)) {
    delete localOpts.project;
  }

  const localResult = tasks.listTasks(localOpts);
  const ghTasks = await fetchGithubTasks(options);

  const filterKeys = {
    status: options.status,
    urgent: options.urgent,
    important: options.important,
    tag: options.tag
  };
  const ghFiltered = applyFilters(ghTasks, filterKeys);

  const merged = tasks.eisenhowerSort([...localResult.tasks, ...ghFiltered]);
  return {
    tasks: merged,
    total: merged.length,
    local_count: localResult.tasks.length,
    github_count: ghFiltered.length
  };
}

async function getTodayTasksWithGithub(daysAhead = 2) {
  const local = tasks.getTodayTasks(daysAhead);
  const gh = await fetchGithubTasks({});
  return tasks.eisenhowerSort([...local, ...gh]);
}

module.exports = {
  listTasksWithGithub,
  getTodayTasksWithGithub,
  GH_PREFIX
};
