import {get, post, put, Response} from 'superagent';

import {
  CreatePullRequestOptions,
  CreateWebhook,
  GitApi,
  GitEvent,
  GitHeader,
  MergePullRequestOptions,
  PullRequest,
  UnknownWebhookError,
  WebhookAlreadyExists
} from '../git.api';
import {GitHookConfig, GitHookContentType, TypedGitRepoConfig} from '../git.model';
import {GitBase} from '../git.base';
import {isResponseError} from '../../util/superagent-support';
import {timer} from '../timer';

export interface GitHookData {
  name: 'web';
  active: boolean;
  events: GithubEvent[];
  config: GitHookConfig;
}

enum GithubHeader {
  event = 'X-GitHub-Event'
}

enum GithubEvent {
  push = 'push',
  pullRequest = 'pull_request'
}

enum GitHookUrlVerification {
  performed = '0',
  notPerformed = '1'
}

interface Tree {
  path: string;
  mode: string;
  type: 'blob' | 'tree';
  size?: number;
  sha: string;
  url: string;
}

interface TreeResponse {
  sha: string;
  url: string;
  tree: Tree[];
  truncated?: boolean;
}

interface FileResponse {
  content: string;
  encoding: 'base64';
  url: string;
  sha: string;
  size: number;
  node_id: string;
}

interface RepoResponse {
  default_branch: string;
}

abstract class GithubCommon extends GitBase implements GitApi {
  protected constructor(config: TypedGitRepoConfig) {
    super(config);
  }

  abstract getBaseUrl(): string;

  async listFiles(): Promise<Array<{path: string, url?: string, contents?: string}>> {
    const response: Response = await this.get(`/git/trees/${this.config.branch}`);

    const treeResponse: TreeResponse = response.body;

    return treeResponse.tree.filter(tree => tree.type === 'blob');
  }

  async getFileContents(fileDescriptor: {path: string, url?: string}): Promise<string | Buffer> {
    const response: Response = await this.get(fileDescriptor.url || '/contents/' + fileDescriptor.path);

    const fileResponse: FileResponse = response.body;

    return new Buffer(fileResponse.content, fileResponse.encoding);
  }

  async getDefaultBranch(): Promise<string> {
    const response: Response = await this.get();

    const treeResponse: RepoResponse = response.body;

    return treeResponse.default_branch;
  }

  private async exec<T>(f: () => Promise<T>, name: string): Promise<T> {
    const rateLimitRegex = /.*secondary rate limit.*/g;
    while (true) {
      try {
        return f();
      } catch (err) {
        if (isResponseError(err) && err.status === 403 && rateLimitRegex.test(err.message)) {
          const retryAfter = err.response.header['Retry-After'] || 30;

          const time = retryAfter * 1000 + (1000 * Math.random());

          this.logger.debug(`${name}: Got secondary rate limit error. Waiting ${time}ms before retry.`)
          await timer(time);
        } else {
          this.logger.debug(`${name}: Error calling api`, {error: err, isResponseError: isResponseError(err), status: err.status});
          throw err;
        }
      }
    }
  }

  async getPullRequest(pullNumber: number): Promise<PullRequest> {

    const f = async (): Promise<PullRequest> => {
      const response: Response = await this.get(`/pulls/${pullNumber}`);

      return {
        pullNumber: response.body.number,
        sourceBranch: response.body.head.ref,
        targetBranch: response.body.base.ref,
      };
    };

    return this.exec(f, 'getPullRequest');
  }

  async createPullRequest(options: CreatePullRequestOptions): Promise<PullRequest> {

    const f = async (): Promise<PullRequest> => {
      const response: Response = await this.post('/pulls', {
        title: options.title,
        head: options.sourceBranch,
        base: options.targetBranch,
        maintainer_can_modify: options.maintainer_can_modify,
        draft: options.draft || false,
      });

      return {
        pullNumber: response.body.number,
        sourceBranch: options.sourceBranch,
        targetBranch: options.targetBranch,
      };
    };

    return this.exec(f, 'createPullRequest');
  }

  async mergePullRequest(options: MergePullRequestOptions): Promise<string> {

    const f = async (): Promise<string> => {
      const response: Response = await this.put(`/pulls/${options.pullNumber}/merge`, {
        commit_title: options.title,
        commit_message: options.message,
        merge_method: options.method,
      });

      return response.body.message;
    }

    return this.exec(f, 'mergePullRequest');
  }

  async updatePullRequestBranch(pullNumber:number): Promise<string> {

    const f = async (): Promise<string> => {
      const response: Response = await this.put(`/pulls/${pullNumber}/update-branch`);

      return response.body.message;
    }

    return this.exec(f, 'updatePullRequestBranch');
  }

  async createWebhook(options: CreateWebhook): Promise<string> {

    try {
      const response: Response = await this.post('/hooks', this.buildWebhookData(options));

      return response.body.id;
    } catch (err) {
      if (isResponseError(err)) {
        if (err.response.text.match(/Hook already exists/)) {
          throw new WebhookAlreadyExists('Webhook already exists on repository', err);
        } else {
          throw new UnknownWebhookError('Unknown error creating webhook', err);
        }
      } else {
        throw new UnknownWebhookError(err.message, err);
      }
    }
  }

  getRefPath(): string {
    return 'body.ref';
  }

  getRef(): string {
    return `refs/heads/${this.config.branch}`;
  }

  getRevisionPath(): string {
    return 'body.head_commit.id';
  }

  getRepositoryUrlPath(): string {
    return 'body.repository.url';
  }

  getRepositoryNamePath(): string {
    return 'body.repository.full_name';
  }

  getHeader(headerId: GitHeader): string {
    return GithubHeader[headerId];
  }

  getEventName(eventId: GitEvent): string {
    return GithubEvent[eventId];
  }

  async get(uri: string = ''): Promise<Response> {
    const url: string = uri.startsWith('http') ? uri : this.getBaseUrl() + uri;

    return get(url)
      .auth(this.config.username, this.config.password)
      .set('User-Agent', `${this.config.username} via ibm-garage-cloud cli`)
      .accept('application/vnd.github.v3+json');
  }

  async post(uri: string, data: any): Promise<Response> {
    return post(this.getBaseUrl() + uri)
      .auth(this.config.username, this.config.password)
      .set('User-Agent', `${this.config.username} via ibm-garage-cloud cli`)
      .accept('application/vnd.github.v3+json')
      .send(data);
  }

  async put(uri: string, data: any = {}): Promise<Response> {
    return put(this.getBaseUrl() + uri)
      .auth(this.config.username, this.config.password)
      .set('User-Agent', `${this.config.username} via ibm-garage-cloud cli`)
      .accept('application/vnd.github.v3+json')
      .send(data);
  }

  buildWebhookData({jenkinsUrl, webhookUrl}: {jenkinsUrl?: string, webhookUrl?: string}): GitHookData {
    const url: string = webhookUrl ? webhookUrl : `${jenkinsUrl}/github-webhook/`;

    const config: GitHookConfig = {
      url,
      content_type: GitHookContentType.json,
      insecure_ssl: GitHookUrlVerification.performed as any,
    };

    const pushGitHook: GitHookData = {
      name: 'web',
      events: [GithubEvent.push],
      active: true,
      config,
    };

    return pushGitHook;
  }
}

export class Github extends GithubCommon {
  constructor(config: TypedGitRepoConfig) {
    super(config);
  }

  getBaseUrl(): string {
    return `https://api.github.com/repos/${this.config.owner}/${this.config.repo}`;
  }
}

export class GithubEnterprise extends GithubCommon {
  constructor(config: TypedGitRepoConfig) {
    super(config);
  }

  getBaseUrl(): string {
    return `${this.config.protocol}://${this.config.host}/api/v3/repos/${this.config.owner}/${this.config.repo}`;
  }
}
