import { createTemplateAction } from '@backstage/plugin-scaffolder-node';
import sodium from 'tweetsodium';
import { execFileSync } from 'node:child_process';

const sleep = (milliseconds: number) =>
  new Promise(resolve => setTimeout(resolve, milliseconds));

function parseRepoUrl(repoUrl: string) {
  const url = new URL(`https://${repoUrl}`);
  const owner = url.searchParams.get('owner');
  const repo = url.searchParams.get('repo');
  if (!owner || !repo) {
    throw new Error(`Invalid repository URL: ${repoUrl}`);
  }
  return { owner, repo };
}

// Argo CD runs in-cluster and can't read the GitHub Actions secrets stored on app repos,
// so it needs its own copy of the same GITOPS_TOKEN registered as a Kubernetes Secret.
// This reuses the token the backend already holds - no separate secret store to configure.
function ensureArgoCdRepoCredentials(
  ctx: { logger: { info: (msg: string) => void; warn: (msg: string) => void } },
  gitopsRepository: string,
  gitopsToken: string,
) {
  const clusterName = process.env.EKS_CLUSTER_NAME ?? 'idp-dev-eks';
  const awsRegion = process.env.AWS_REGION ?? 'us-east-1';
  try {
    execFileSync('aws', ['eks', 'update-kubeconfig', '--name', clusterName, '--region', awsRegion], { stdio: 'ignore' });

    let exists = false;
    try {
      execFileSync('kubectl', ['get', 'secret', 'idp-gitops-repo', '-n', 'argocd'], { stdio: 'ignore' });
      exists = true;
    } catch {
      exists = false;
    }
    if (exists) {
      ctx.logger.info('Argo CD GitOps repository credentials already registered, skipping.');
      return;
    }

    execFileSync('kubectl', [
      'create', 'secret', 'generic', 'idp-gitops-repo', '-n', 'argocd',
      '--from-literal=type=git',
      `--from-literal=url=https://github.com/${gitopsRepository}.git`,
      '--from-literal=username=x-access-token',
      `--from-literal=password=${gitopsToken}`,
    ], { stdio: 'ignore' });
    execFileSync('kubectl', [
      'label', 'secret', 'idp-gitops-repo', '-n', 'argocd',
      'argocd.argoproj.io/secret-type=repository', '--overwrite',
    ], { stdio: 'ignore' });
    ctx.logger.info('Registered Argo CD GitOps repository credentials in the cluster.');
  } catch (error) {
    ctx.logger.warn(
      `Could not automatically register Argo CD repo credentials (${String(error)}). ` +
        'Argo CD sync status may show Unknown until this secret exists in the argocd namespace.',
    );
  }
}

async function githubRequest<T>(token: string, path: string, init: RequestInit = {}) {
  const response = await fetch(`https://api.github.com${path}`, {
    ...init,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28',
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...init.headers,
    },
  });
  if (!response.ok) {
    throw new Error(`GitHub API ${response.status}: ${await response.text()}`);
  }
  if (response.status === 204) {
    return undefined as T;
  }
  const body = await response.text();
  return (body ? JSON.parse(body) : undefined) as T;
}

export const createIdpProvisionServiceAction = () =>
  createTemplateAction({
    id: 'idp:provision-service',
    description:
      'Commits the service contract to IDP-Infra, waits for Terraform Cloud, configures GitHub Actions, and starts CI.',
    schema: {
      input: {
        appRepoUrl: z => z.string(),
        applicationName: z => z.string(),
        environment: z => z.string(),
        runtime: z => z.string(),
        targetCluster: z => z.string(),
        namespace: z => z.string(),
        replicas: z => z.number(),
        cpu: z => z.string(),
        memory: z => z.string(),
        ingress: z => z.boolean(),
        hpa: z => z.boolean(),
        albScheme: z => z.enum(['internal', 'internet-facing']),
        ingressHost: z => z.string().optional(),
        ingressPath: z => z.string(),
        ingressServicePort: z => z.number().int().min(1).max(65535),
        hpaMinReplicas: z => z.number().int().min(1),
        hpaMaxReplicas: z => z.number().int().min(1),
        hpaCpuTarget: z => z.number().int().min(1).max(100),
        hpaMemoryTarget: z => z.number().int().min(1).max(100),
      },
      output: {
        terraformRunId: z => z.string(),
        roleArn: z => z.string(),
        repositoryUrl: z => z.string(),
      },
    },
    async handler(ctx) {
      const githubToken = process.env.GITHUB_TOKEN;
      const gitopsToken = process.env.GITOPS_TOKEN;
      const terraformToken = process.env.TFC_TOKEN;
      const infraRepo = process.env.IDP_INFRA_REPOSITORY ?? 'muthukannanmuruga/IDP-Infra';
      const terraformOrganization = process.env.TFC_ORGANIZATION;
      const terraformWorkspace = process.env.TFC_WORKSPACE ?? 'IDP-Infra';
      const awsRegion = process.env.AWS_REGION ?? 'us-east-1';
      const awsAccountId = process.env.AWS_ACCOUNT_ID;

      if (!githubToken || !gitopsToken || !terraformToken || !terraformOrganization || !awsAccountId) {
        throw new Error(
          'Missing platform configuration: GITHUB_TOKEN, GITOPS_TOKEN, TFC_TOKEN, TFC_ORGANIZATION, AWS_ACCOUNT_ID',
        );
      }

      const appRepo = parseRepoUrl(ctx.input.appRepoUrl);
      const [infraOwner, infraName] = infraRepo.split('/');
      if (!infraOwner || !infraName) throw new Error(`Invalid IDP_INFRA_REPOSITORY: ${infraRepo}`);

      if (ctx.input.hpaMaxReplicas < ctx.input.hpaMinReplicas) {
        throw new Error('hpaMaxReplicas must be greater than or equal to hpaMinReplicas.');
      }

      const startedAt = Date.now();
      const manifest = [
        `name: ${ctx.input.applicationName}`,
        `github_owner: ${appRepo.owner}`,
        `github_repository: ${appRepo.repo}`,
        'github_branch: main',
        `aws_region: ${awsRegion}`,
        `environment: ${ctx.input.environment}`,
        `target_cluster: ${ctx.input.targetCluster}`,
        `namespace: ${ctx.input.namespace}`,
        `replicas: ${ctx.input.replicas}`,
        `cpu: ${ctx.input.cpu}`,
        `memory: ${ctx.input.memory}`,
        `ingress: ${ctx.input.ingress}`,
        `hpa: ${ctx.input.hpa}`,
        `alb_scheme: ${ctx.input.albScheme}`,
        `ingress_host: ${ctx.input.ingressHost ?? ''}`,
        `ingress_path: ${ctx.input.ingressPath}`,
        `ingress_service_port: ${ctx.input.ingressServicePort}`,
        `hpa_min_replicas: ${ctx.input.hpaMinReplicas}`,
        `hpa_max_replicas: ${ctx.input.hpaMaxReplicas}`,
        `hpa_cpu_target: ${ctx.input.hpaCpuTarget}`,
        `hpa_memory_target: ${ctx.input.hpaMemoryTarget}`,
        '',
      ].join('\n');

      const path = `environments/dev/services/${ctx.input.applicationName}.yaml`;
      await githubRequest(githubToken, `/repos/${infraOwner}/${infraName}/contents/${path}`, {
        method: 'PUT',
        body: JSON.stringify({
          message: `Provision ${ctx.input.applicationName}`,
          content: Buffer.from(manifest).toString('base64'),
          branch: 'main',
        }),
      });
      ctx.logger.info(`Committed ${path} to ${infraRepo}`);

      let run:
        | { id: string; attributes: { status: string; 'created-at': string; message?: string } }
        | undefined;
      for (let attempt = 0; attempt < 60; attempt += 1) {
        const response = await fetch(
          `https://app.terraform.io/api/v2/runs?filter[organization][name]=${encodeURIComponent(terraformOrganization)}&filter[workspace][name]=${encodeURIComponent(terraformWorkspace)}&page[size]=20`,
          { headers: { Authorization: `Bearer ${terraformToken}`, 'Content-Type': 'application/vnd.api+json' } },
        );
        if (!response.ok) throw new Error(`Terraform Cloud API ${response.status}: ${await response.text()}`);
        const body = (await response.json()) as { data: NonNullable<typeof run>[] };
        run = body.data.find(item => new Date(item.attributes['created-at']).getTime() >= startedAt - 5000 && item.attributes.message?.includes(ctx.input.applicationName));
        if (run) break;
        await sleep(5000);
      }
      if (!run) throw new Error('Timed out waiting for the Terraform Cloud run.');

      for (let attempt = 0; attempt < 120; attempt += 1) {
        const response = await fetch(`https://app.terraform.io/api/v2/runs/${run.id}`, {
          headers: { Authorization: `Bearer ${terraformToken}`, 'Content-Type': 'application/vnd.api+json' },
        });
        if (!response.ok) throw new Error(`Terraform Cloud run lookup failed: ${response.status}`);
        const current = (await response.json()) as { data: NonNullable<typeof run> };
        const status = current.data.attributes.status;
        ctx.logger.info(`Terraform Cloud run ${run.id}: ${status}`);
        if (status === 'applied') break;
        if (['errored', 'canceled', 'force_canceled', 'discarded'].includes(status)) {
          throw new Error(`Terraform Cloud run ${run.id} ended with status ${status}.`);
        }
        await sleep(5000);
        if (attempt === 119) throw new Error('Timed out waiting for Terraform Cloud apply.');
      }

      const roleArn = `arn:aws:iam::${awsAccountId}:role/github-actions-${ctx.input.applicationName}-ecr`;
      const variables = {
        AWS_REGION: awsRegion,
        AWS_ROLE_ARN: roleArn,
        GITOPS_REPOSITORY: process.env.GITOPS_REPOSITORY ?? 'muthukannanmuruga/IDP-GitOps',
        APP_NAMESPACE: ctx.input.namespace,
        APP_ENVIRONMENT: ctx.input.environment,
        APP_CLUSTER: ctx.input.targetCluster,
        APP_REPLICAS: String(ctx.input.replicas),
        APP_CPU: ctx.input.cpu,
        APP_MEMORY: ctx.input.memory,
        APP_INGRESS: String(ctx.input.ingress),
        APP_HPA: String(ctx.input.hpa),
        APP_ALB_SCHEME: ctx.input.albScheme,
        APP_INGRESS_HOST: ctx.input.ingressHost ?? '',
        APP_INGRESS_PATH: ctx.input.ingressPath,
        APP_INGRESS_SERVICE_PORT: String(ctx.input.ingressServicePort),
        APP_HPA_MIN_REPLICAS: String(ctx.input.hpaMinReplicas),
        APP_HPA_MAX_REPLICAS: String(ctx.input.hpaMaxReplicas),
        APP_HPA_CPU_TARGET: String(ctx.input.hpaCpuTarget),
        APP_HPA_MEMORY_TARGET: String(ctx.input.hpaMemoryTarget),
      };
      for (const [name, value] of Object.entries(variables)) {
        if (value === '') continue; // GitHub rejects empty repository variable values
        const variablePath = `/repos/${appRepo.owner}/${appRepo.repo}/actions/variables`;
        try {
          await githubRequest(githubToken, variablePath, {
            method: 'POST',
            body: JSON.stringify({ name, value }),
          });
        } catch (error) {
          if (!(error instanceof Error) || !error.message.startsWith('GitHub API 409:')) {
            throw error;
          }
          await githubRequest(githubToken, `${variablePath}/${name}`, {
            method: 'PATCH',
            body: JSON.stringify({ name, value }),
          });
        }
      }

      const key = await githubRequest<{ key_id: string; key: string }>(
        githubToken,
        `/repos/${appRepo.owner}/${appRepo.repo}/actions/secrets/public-key`,
      );
      const encrypted = sodium.seal(Buffer.from(gitopsToken), Buffer.from(key.key, 'base64'));
      await githubRequest(githubToken, `/repos/${appRepo.owner}/${appRepo.repo}/actions/secrets/GITOPS_TOKEN`, {
        method: 'PUT',
        body: JSON.stringify({ encrypted_value: Buffer.from(encrypted).toString('base64'), key_id: key.key_id }),
      });

      ensureArgoCdRepoCredentials(ctx, variables.GITOPS_REPOSITORY, gitopsToken);

      // GitHub can accept a dispatch (204) without ever queuing a visible run if the
      // workflow file isn't fully indexed yet, so verify a run actually shows up and
      // re-dispatch if it doesn't, instead of trusting the 204 response alone.
      const dispatchedAt = Date.now();
      let runVisible = false;
      let lastDispatchError: unknown;
      for (let attempt = 0; attempt < 4 && !runVisible; attempt += 1) {
        if (attempt > 0) await sleep(5000);
        try {
          await githubRequest(githubToken, `/repos/${appRepo.owner}/${appRepo.repo}/actions/workflows/ci.yml/dispatches`, {
            method: 'POST',
            body: JSON.stringify({ ref: 'main' }),
          });
          ctx.logger.info(`Requested ci.yml workflow_dispatch (attempt ${attempt + 1})`);
        } catch (error) {
          lastDispatchError = error;
          ctx.logger.warn(`workflow_dispatch request failed (attempt ${attempt + 1}): ${String(error)}`);
          continue;
        }

        for (let check = 0; check < 4 && !runVisible; check += 1) {
          await sleep(3000);
          const runs = await githubRequest<{ workflow_runs: { event: string; created_at: string; html_url: string }[] }>(
            githubToken,
            `/repos/${appRepo.owner}/${appRepo.repo}/actions/runs?event=workflow_dispatch&branch=main`,
          );
          const queued = runs.workflow_runs.find(run => new Date(run.created_at).getTime() >= dispatchedAt - 2000);
          if (queued) {
            runVisible = true;
            ctx.logger.info(`ci.yml workflow_dispatch run queued: ${queued.html_url}`);
          }
        }
      }
      if (!runVisible) {
        ctx.logger.warn(
          `ci.yml did not visibly re-run after dispatch (${String(lastDispatchError)}). ` +
            `Infrastructure and the GitHub repository were still provisioned successfully; ` +
            `manually re-run the "CI/CD" workflow from the Actions tab of ${appRepo.owner}/${appRepo.repo}.`,
        );
      }
      ctx.output('terraformRunId', run.id);
      ctx.output('roleArn', roleArn);
      ctx.output('repositoryUrl', `https://github.com/${appRepo.owner}/${appRepo.repo}`);
    },
  });
