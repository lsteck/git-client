import {get, post, Response} from 'superagent';

import {
  CreatePullRequestOptions,
  CreateWebhook,
  GitApi,
  GitEvent,
  GitHeader, MergePullRequestOptions, PullRequest,
  UnknownWebhookError,
  WebhookAlreadyExists
} from '../git.api';
import {GitBase} from '../git.base';
import {TypedGitRepoConfig} from '../git.model';
import {isResponseError} from '../../util/superagent-support';
import first from '../../util/first';

interface GitlabHookData {
  id: string;
  url: string;
  push_events?: boolean;
  enable_ssl_verification?: boolean;
  token?: string;
}

interface GitlabParams {
  owner: string;
  repo: string;
  jenkinsUrl?: string;
  jenkinsUser?: string;
  jenkinsPassword?: string;
  jobName?: string;
  webhookUrl?: string;
}

enum GitlabHeader {
  event = 'X-GitLab-Event'
}

enum GitlabEvent {
  push = 'Push Hook'
}

interface Tree {
  id: string;
  name: string;
  type: 'blob' | 'tree';
  path: string;
  mode: string;
}

interface FileResponse {
  file_name: string;
  file_path: string;
  size: number;
  encoding: 'base64';
  content: string;
  content_sha256: string;
  ref: string;
  blob_id: string;
  commit_id: string;
  last_commit_id: string;
}

interface Branch {
  name: string;
  default: boolean;
}

export class Gitlab extends GitBase implements GitApi {
  constructor(config: TypedGitRepoConfig) {
    super(config);
  }

  getBaseUrl(): string {
    return `${this.config.protocol}://${this.config.host}/api/v4/projects/${this.config.owner}%2F${this.config.repo}`;
  }

  async listFiles(): Promise<Array<{path: string, url?: string, contents?: string}>> {
    const response: Response = await get(this.buildUrl(this.getBaseUrl() + '/repository/tree', [this.branchParam(), 'per_page=1000']))
      .set('Private-Token', this.config.password)
      .set('User-Agent', `${this.config.username} via ibm-garage-cloud cli`)
      .accept('application/json');

    const treeResponse: Tree[] = response.body;

    return treeResponse
      .filter(tree => tree.type === 'blob')
      .map(tree => ({
        path: tree.path.replace('files/', ''),
        url: this.getBaseUrl() + '/repository/' + tree.path,
      }));
  }

  async getFileContents(fileDescriptor: {path: string, url?: string}): Promise<string | Buffer> {
    const response: Response = await get(fileDescriptor.url)
      .set('Private-Token', this.config.password)
      .set('User-Agent', `${this.config.username} via ibm-garage-cloud cli`)
      .accept('application/json');

    const fileResponse: FileResponse = response.body;

    return new Buffer(fileResponse.content, fileResponse.encoding);
  }

  async getPullRequest(pullNumber: number): Promise<PullRequest> {

    throw new Error('Method not implemented: getPullRequest')
  }

  async createPullRequest(options: CreatePullRequestOptions): Promise<PullRequest> {

    throw new Error('Method not implemented: createPullRequest')
  }

  async mergePullRequest(options: MergePullRequestOptions): Promise<string> {

    throw new Error('Method not implemented: mergePullRequest')
  }

  async updatePullRequestBranch(pullNumber:number): Promise<string> {

    throw new Error('Method not implemented: updatePullRequestBranch')
  }

  async getDefaultBranch(): Promise<string> {
    const response: Response = await get(this.getBaseUrl() + '/repository/branches')
      .set('Private-Token', this.config.password)
      .set('User-Agent', `${this.config.username} via ibm-garage-cloud cli`)
      .accept('application/json');

    const branchResponse: Branch[] = response.body;

    return first(branchResponse.filter(branch => branch.default).map(branch => branch.name));
  }

  private buildUrl(url: string, params: string[] = []): string {
    const paramString: string = params.filter(p => !!p).join('&');

    const values: string[] = [url];
    if (paramString) {
      values.push(paramString);
    }

    return values.join('?');
  }

  private branchParam(): string {
    return this.config.branch ? `ref=${this.config.branch}` : '';
  }

  async createWebhook(options: CreateWebhook): Promise<string> {
    try {
      const response: Response = await post(this.getBaseUrl() + '/hooks')
        .set('Private-Token', this.config.password)
        .set('User-Agent', `${this.config.username} via ibm-garage-cloud cli`)
        .accept('application/json')
        .send(this.buildWebhookData(Object.assign({}, this.config, options)));

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

  buildWebhookData({owner, repo, jenkinsUrl = 'https://jenkins.local/', jenkinsUser, jenkinsPassword, jobName, webhookUrl}: GitlabParams): GitlabHookData {
    const urlParts = /(.*):\/\/(.*)\/*/.exec(jenkinsUrl);
    const protocol = urlParts[1];
    const host = urlParts[2];

    const credentials = (jenkinsUser && jenkinsPassword)
      ? `${jenkinsUser}:${jenkinsPassword}@`
      : '';

    const url = webhookUrl
      ? webhookUrl
      : `${protocol}://${credentials}${host}/project/${jobName}`;

    return {
      id: `${this.config.owner}%2F${this.config.repo}`,
      url,
      push_events: true,
      enable_ssl_verification: (protocol === 'https'),
    };
  }

  getRefPath(): string {
    return 'body.ref';
  }

  getRef(): string {
    return `refs/heads/${this.config.branch}`;
  }

  getRevisionPath(): string {
    return 'body.checkout_sha';
  }

  getRepositoryUrlPath(): string {
    return 'body.repository.git_http_url';
  }

  getRepositoryNamePath(): string {
    return 'body.project.path_with_namespace'
  }

  getHeader(headerId: GitHeader): string {
    return GitlabHeader[headerId];
  }

  getEventName(eventId: GitEvent): string {
    return GitlabEvent[eventId];
  }

}
