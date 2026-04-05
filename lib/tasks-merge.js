'use strict';

/**
 * Объединяет локальный трекер (SQLite) и GitHub Milestones с близким дедлайном
 * в один список в формате задач для чата, list_tasks и мини-приложения.
 */

const tasks = require('./tasks');
const github = require('./github');

const GH_PREFIX = 'gh:';

function milestoneToTask(m) {
  const days = m.days_until_due;
  const urgent = typeof days === 'number' && days <= 3;
  const openN = m.open_issues_count;
  const notes =
    typeof openN === 'number' ? `${openN} open issue${openN === 1 ? '' : 's'} in milestone` : null;
  return {
    id: m.number,
    title: m.title,
    status: 'pending',
    urgent,
    important: true,
    project: `${GH_PREFIX}${m.repo}`,
    tags: ['github', 'milestone'],
    due_date: m.due_date || null,
    notes,
    created_at: null,
    updated_at: m.updated_at || null,
    source: 'github',
    github_url: m.url,
    github_repo: m.repo,
    linked_project: m.project || null,
    github_kind: 'milestone',
    days_until_due: days
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

  let milestones = await github.getUpcomingMilestones(confProject);
  if (repoFromPrefix) {
    milestones = milestones.filter(m => m.repo === repoFromPrefix);
  }
  return milestones.map(milestoneToTask);
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

/**
 * @param {number} daysAhead — горизонт для локальных задач (due_date)
 * @param {object} [opts]
 * @param {boolean} [opts.wideGithubWindow] — если true, все GitHub-вехи из getUpcomingMilestones (брифинг);
 *   если false (по умолчанию), вехи только с days_until_due ≤ daysAhead (вкладка «сегодня» в Mini App)
 */
async function getTodayTasksWithGithub(daysAhead = 2, opts = {}) {
  const local = tasks.getTodayTasks(daysAhead);
  let gh = await fetchGithubTasks({});
  if (!opts.wideGithubWindow) {
    gh = gh.filter(t => {
      if (t.source !== 'github') return true;
      const d = t.days_until_due;
      return typeof d !== 'number' || d <= daysAhead;
    });
  }
  return tasks.eisenhowerSort([...local, ...gh]);
}

module.exports = {
  listTasksWithGithub,
  getTodayTasksWithGithub,
  GH_PREFIX
};
