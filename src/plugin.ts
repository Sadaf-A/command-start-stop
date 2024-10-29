import { paginateGraphQL } from "@octokit/plugin-paginate-graphql";
import { Octokit } from "@octokit/rest";
import { createClient } from "@supabase/supabase-js";
import { LogReturn, Logs } from "@ubiquity-os/ubiquity-os-logger";
import { createAdapters } from "./adapters";
import { userPullRequest, userSelfAssign, userStartStop, userUnassigned } from "./handlers/user-start-stop";
import { Context, Env, GitHubIssueSearch, PluginInputs } from "./types";
import { addCommentToIssue } from "./utils/issue";

async function listOrganizations(logger: Logs): Promise<string[]> {
  const orgsSet: Set<string> = new Set();
  const urlPattern = /https:\/\/github\.com\/(\S+)\/\S+\/issues\/\d+/;

  const url = "https://raw.githubusercontent.com/ubiquity/devpool-directory/refs/heads/__STORAGE__/devpool-issues.json";
  const response = await fetch(url);
  if (!response.ok) {
    if (response.status === 404) {
      throw logger.error(`Error 404: unable to fetch file devpool-issues.json ${url}`);
    } else {
      throw logger.error("Error fetching file devpool-issues.json.", { status: response.status });
    }
  }

  const devpoolIssues: GitHubIssueSearch["items"] = await response.json();
  devpoolIssues.forEach((issue) => {
    const match = issue.html_url.match(urlPattern);
    if (match) {
      orgsSet.add(match[1]);
    }
  });

  return [...orgsSet];
}

export async function startStopTask(inputs: PluginInputs, env: Env) {
  const customOctokit = Octokit.plugin(paginateGraphQL);
  const octokit = new customOctokit({ auth: inputs.authToken });
  const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_KEY);

  const context: Context = {
    eventName: inputs.eventName,
    payload: inputs.eventPayload,
    config: inputs.settings,
    organizations: [],
    octokit,
    env,
    logger: new Logs("info"),
    adapters: {} as ReturnType<typeof createAdapters>,
  };

  context.adapters = createAdapters(supabase, context);

  try {
    const organizations = await listOrganizations(context.logger);
    context.organizations = organizations;

    switch (context.eventName) {
      case "issue_comment.created":
        return await userStartStop(context);
      case "issues.assigned":
        return await userSelfAssign(context as Context<"issues.assigned">);
      case "pull_request.opened":
        return await userPullRequest(context as Context<"pull_request.edited">);
      case "pull_request.edited":
        return await userPullRequest(context as Context<"pull_request.opened">);
      case "issues.unassigned":
        return await userUnassigned(context);
      default:
        context.logger.error(`Unsupported event: ${context.eventName}`);
    }
  } catch (err) {
    let errorMessage;
    if (err instanceof LogReturn) {
      errorMessage = err;
      await addCommentToIssue(context, `${errorMessage?.logMessage.diff}\n<!--\n${sanitizeMetadata(errorMessage?.metadata)}\n-->`);
    } else {
      context.logger.error("An error occurred", { err });
    }
  }
}

function sanitizeMetadata(obj: LogReturn["metadata"]): string {
  return JSON.stringify(obj, null, 2).replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/--/g, "&#45;&#45;");
}
