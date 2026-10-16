// Exam scenarios for the CKA practice lab, adapted from the "CKA 2025" YouTube playlist by
// DumbITGuy (see scenarioSource). Each entry is a task in the same shape as tasks.js, plus
// `num` (the question number used in the videos) and `videos` ([title, url] pairs to credit).
//
// Names follow the videos where they name something; scenarios the videos solve in the default
// namespace get a namespace of their own here so that cleanup can remove them safely.

const { NGINX, BUSYBOX, DOCS, PROFILE, ns, deploy, delNs } = require('./tasks').helpers;

const YT = 'https://www.youtube.com/watch?v=';

const scenarioSource = {
  title: 'CKA 2025',
  author: 'DumbITGuy',
  url: 'https://youtube.com/playlist?list=PLvZb3tGyqC1TOasSaN36haM5xlCxHQBlA',
  authorUrl: 'https://www.youtube.com/@dumbitguy7000',
};

// Throwaway self-signed certificate (CN ckaquestion.k8s.local) for the TLS scenario. It protects
// nothing: it only lets nginx serve HTTPS so that the TLS versions can really be tested.
const PRACTICE_TLS_CRT = `-----BEGIN CERTIFICATE-----
MIIBwzCCAWmgAwIBAgIUR2nK5vbdbz6HhUwBbdm0L3+Vh/0wCgYIKoZIzj0EAwIw
IDEeMBwGA1UEAwwVY2thcXVlc3Rpb24uazhzLmxvY2FsMB4XDTI2MTAwNzEzNTEy
N1oXDTM2MTAwNDEzNTEyN1owIDEeMBwGA1UEAwwVY2thcXVlc3Rpb24uazhzLmxv
Y2FsMFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEx4/wE09r+w8Zsooam13LBNwf
isbXjqKAVpGbI+iDzgXjX/mhXOnjDvGin1tbYTife3uiQwM9qYoZ7Uz5SY9XU6OB
gDB+MB0GA1UdDgQWBBTfUnD/wx1aBXpvPbNoDJjqz5KsIDAfBgNVHSMEGDAWgBTf
UnD/wx1aBXpvPbNoDJjqz5KsIDAPBgNVHRMBAf8EBTADAQH/MCsGA1UdEQQkMCKC
FWNrYXF1ZXN0aW9uLms4cy5sb2NhbIIJbG9jYWxob3N0MAoGCCqGSM49BAMCA0gA
MEUCIEW4vkZzZSNZpeV/UOiKjnctipRnwgFP18HRSoJv7sUWAiEAyEBsJ2kn/cop
ALlDTuLKb95kl83/8SRLj/6T19aWdAA=
-----END CERTIFICATE-----`;
const PRACTICE_TLS_KEY = `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgsRk7i1CSo8jF7nQk
MYbZX1s/dq7djI4hdhAIW237qHKhRANCAATHj/ATT2v7DxmyihqbXcsE3B+KxteO
ooBWkZsj6IPOBeNf+aFc6eMO8aKfW1thOJ97e6JDAz2pihntTPlJj1dT
-----END PRIVATE KEY-----`;
const indent = (text, n) => text.replace(/^/gm, ' '.repeat(n));

const DEFAULT_SC = '{"metadata":{"annotations":{"storageclass.kubernetes.io/is-default-class":"true"}}}';
const GATEWAY_CRDS = 'https://github.com/kubernetes-sigs/gateway-api/releases/download/v1.2.1/standard-install.yaml';
const ARGO_CRDS = ['application-crd', 'applicationset-crd', 'appproject-crd'].map((f) => `https://raw.githubusercontent.com/argoproj/argo-cd/v2.13.0/manifests/crds/${f}.yaml`);
const CERT_MANAGER_CRDS = 'https://github.com/cert-manager/cert-manager/releases/download/v1.17.2/cert-manager.crds.yaml';

const MARIADB_DEPLOY = `apiVersion: apps/v1
kind: Deployment
metadata:
  name: mariadb
  namespace: mariadb
spec:
  replicas: 1
  selector:
    matchLabels:
      app: mariadb
  template:
    metadata:
      labels:
        app: mariadb
    spec:
      containers:
      - name: mariadb
        image: mariadb:11.4
        env:
        - name: MARIADB_ROOT_PASSWORD
          value: practice-only
        ports:
        - containerPort: 3306
        volumeMounts:
        - name: mariadb-data
          mountPath: /var/lib/mysql
      volumes:
      - name: mariadb-data
        persistentVolumeClaim:
          claimName: ""
`;

const netpol = (name, spec) => `apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: ${name}
  namespace: backend
spec:
${spec}`;

const scenarios = [
  {
    id: 'sc-pv-mariadb',
    num: 'Q1',
    domain: 'stor',
    title: 'Restore MariaDB on its retained PersistentVolume',
    difficulty: 'Medium',
    minutes: 8,
    lab: true,
    scenario: `A user accidentally deleted the \`mariadb\` Deployment in namespace \`mariadb\`. It was configured with persistent storage, and you have to re-establish it while preserving the data by reusing the existing PersistentVolume.

A PersistentVolume already exists and is retained for reuse — it is the only one for this application.

- Create a PersistentVolumeClaim \`mariadb\` in namespace \`mariadb\` with access mode \`ReadWriteOnce\` and \`250Mi\` of storage. It must bind to the existing PV.
- Edit the Deployment manifest \`mariadb-deploy.yaml\` (in the workspace folder; \`~/mariadb-deploy.yaml\` in the exam) so that it uses that claim.
- Apply the manifest and make sure the Deployment is running and stable.`,
    setup: {
      files: { 'mariadb-deploy.yaml': MARIADB_DEPLOY },
      yaml:
        ns('mariadb') +
        `---
apiVersion: v1
kind: PersistentVolume
metadata:
  name: mariadb-pv
spec:
  capacity:
    storage: 250Mi
  accessModes: ["ReadWriteOnce"]
  persistentVolumeReclaimPolicy: Retain
  storageClassName: local-path
  hostPath:
    path: /mnt/cka-scenarios/mariadb
`,
    },
    checks: [
      { desc: 'PVC mariadb is Bound to the existing PV', args: ['get', 'pvc', 'mariadb', '-n', 'mariadb', '-o', 'jsonpath={.status.phase}/{.spec.volumeName}'], expect: { eq: 'Bound/mariadb-pv' } },
      { desc: 'PVC: ReadWriteOnce, 250Mi', args: ['get', 'pvc', 'mariadb', '-n', 'mariadb', '-o', 'jsonpath={.spec.accessModes[0]}/{.spec.resources.requests.storage}'], expect: { eq: 'ReadWriteOnce/250Mi' } },
      { desc: 'mariadb-deploy.yaml references the claim', file: 'mariadb-deploy.yaml', expect: { match: 'claimName:\\s*["\']?mariadb["\']?\\s*$', flags: 'm' } },
      { desc: 'Deployment mounts the claim', args: ['get', 'deploy', 'mariadb', '-n', 'mariadb', '-o', 'jsonpath={.spec.template.spec.volumes[*].persistentVolumeClaim.claimName}'], expect: { eq: 'mariadb' } },
      { desc: 'Deployment is available', args: ['get', 'deploy', 'mariadb', '-n', 'mariadb', '-o', 'jsonpath={.status.availableReplicas}'], expect: { eq: '1' } },
    ],
    hints: ['Look at the PV first: `kubectl get pv mariadb-pv -o yaml`. A claim only binds when access mode, size **and storageClassName** fit.', 'There is no imperative command for a PVC — copy the manifest from the docs page "Persistent Volumes" and delete what the task does not ask for.', 'Open `mariadb-deploy.yaml` from the YAML editor ("Open file…"), fill in `claimName`, Save, then `kubectl apply -f mariadb-deploy.yaml`.', 'The mariadb image is large; the first rollout can take a minute.'],
    solution: `kubectl get pv                                   # mariadb-pv, 250Mi, RWO, Retain, class local-path
kubectl apply -f - <<EOF
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: mariadb
  namespace: mariadb
spec:
  accessModes: ["ReadWriteOnce"]
  storageClassName: local-path
  resources:
    requests:
      storage: 250Mi
EOF
kubectl -n mariadb get pvc                       # Bound to mariadb-pv

# edit mariadb-deploy.yaml:
#       volumes:
#       - name: mariadb-data
#         persistentVolumeClaim:
#           claimName: mariadb
kubectl apply -f mariadb-deploy.yaml
kubectl -n mariadb rollout status deploy/mariadb
kubectl -n mariadb get deploy,pod,pvc`,
    cleanup: [...delNs('mariadb'), ['delete', 'pv', 'mariadb-pv', '--ignore-not-found']],
    cleanupFiles: ['mariadb-deploy.yaml'],
    docs: `${DOCS}/concepts/storage/persistent-volumes/`,
    videos: [['CKA 2025 Q1 - Persistent Volume with Lab', YT + 'aXvvc1EB1zg']],
  },
  {
    id: 'sc-helm-argocd',
    num: 'Q2',
    domain: 'arch',
    title: 'Install Argo CD with Helm, without its CRDs',
    difficulty: 'Medium',
    minutes: 8,
    lab: true,
    scenario: `Install Argo CD in the cluster. The Argo CD CRDs have already been pre-installed.

- Add the official Argo CD Helm repository (\`https://argoproj.github.io/argo-helm\`) with the name \`argo\`.
- Generate a Helm template of the Argo CD chart version \`7.7.3\` for the \`argocd\` namespace and save it to \`~/argo-helm.yaml\`. Configure the chart to **not** install CRDs.
- Install Argo CD with the release name \`argocd\`, using the same version and the same configuration as in the template, in the \`argocd\` namespace.

You do not need to configure access to the Argo CD server.

This lab needs \`helm\` on the machine running this server. \`helm\` commands run in the console, and \`> ~/argo-helm.yaml\` saves into the workspace folder.

**Setup installs the Argo CD CRDs cluster-wide** from the argo-cd \`v2.13.0\` release; they stay installed after cleanup. The install pulls the Argo CD images, so the Pods take a few minutes to start — the checks do not wait for them.`,
    setup: {
      pre: [
        ['apply', '--server-side', ...ARGO_CRDS.flatMap((u) => ['-f', u])],
        ['wait', '--for=condition=Established', 'crd/applications.argoproj.io', 'crd/applicationsets.argoproj.io', 'crd/appprojects.argoproj.io', '--timeout=60s'],
      ],
    },
    checks: [
      { desc: 'argo-helm.yaml is the rendered argo-cd 7.7.3 chart', file: 'argo-helm.yaml', expect: { match: 'helm\\.sh/chart: argo-cd-7\\.7\\.3[\\s\\S]*name: argocd-server' } },
      { desc: 'Template is rendered for namespace argocd', file: 'argo-helm.yaml', expect: { match: 'namespace: "?argocd"?\\s' } },
      { desc: 'Template contains no CRDs', file: 'argo-helm.yaml', expect: { notMatch: 'kind:\\s*CustomResourceDefinition' } },
      { desc: 'Release argocd is deployed in namespace argocd', args: ['get', 'secret', '-n', 'argocd', '-l', 'owner=helm,name=argocd', '-o', 'jsonpath={.items[*].metadata.labels.status}'], expect: { match: '\\bdeployed\\b' } },
      { desc: 'Installed chart version is 7.7.3', args: ['get', 'deploy', 'argocd-server', '-n', 'argocd', '-o', 'jsonpath={.metadata.labels.helm\\.sh/chart}'], expect: { eq: 'argo-cd-7.7.3' } },
      { desc: 'The release did not take over the CRDs', args: ['get', 'crd', 'applications.argoproj.io', '-o', 'jsonpath={.metadata.labels.app\\.kubernetes\\.io/managed-by}'], expect: { eq: '' } },
    ],
    hints: ['The command is `helm repo add`, not `helm add repo`.', '`helm template` and `helm install` take the same arguments: `<release> <repo>/<chart> --namespace … --version … --set …`. Build the template command first, then swap the verb.', 'Look up the value instead of guessing it: `helm show values argo/argo-cd --version 7.7.3` → `crds.install`.', 'Installing with the CRDs enabled fails here, as it would in the exam: they already exist and do not belong to your release.'],
    solution: `kubectl create namespace argocd

helm repo add argo https://argoproj.github.io/argo-helm
helm repo update

# render only
helm template argocd argo/argo-cd --namespace argocd --version 7.7.3 \\
  --set crds.install=false > ~/argo-helm.yaml

# same arguments, "install" instead of "template"
helm install argocd argo/argo-cd --namespace argocd --version 7.7.3 \\
  --set crds.install=false

# verify
helm list -n argocd
kubectl -n argocd get pods
# exam: grep -c 'kind: CustomResourceDefinition' ~/argo-helm.yaml     → 0`,
    cleanup: [...delNs('argocd'), ['delete', 'clusterrole,clusterrolebinding', '-l', 'app.kubernetes.io/part-of=argocd', '--ignore-not-found']],
    cleanupFiles: ['argo-helm.yaml'],
    docs: 'https://helm.sh/docs/helm/helm_template/',
    videos: [['CKA 2025 Question 2 | Install Argo CD using Helm', YT + 'e0YGRSjb8CU']],
  },
  {
    id: 'sc-sidecar',
    num: 'Q3',
    domain: 'work',
    title: 'Add a sidecar to the WordPress Deployment',
    difficulty: 'Medium',
    minutes: 8,
    lab: true,
    scenario: `Update the existing \`wordpress\` Deployment in namespace \`sidecar\` by adding a sidecar container to the existing Pod:

- container name \`sidecar\`, image \`busybox:stable\`
- command \`/bin/sh -c "tail -f /var/log/wordpress.log"\`
- use a volume mounted at \`/var/log\` to make the log file \`wordpress.log\` available to the co-located container

The exam has a twin of this question with a different Deployment name and log file; the solution is the same.`,
    setup: {
      yaml:
        ns('sidecar') +
        deploy({
          name: 'wordpress',
          namespace: 'sidecar',
          image: BUSYBOX,
          extra: `
        command: ["sh", "-c", "while true; do echo \\"$(date) wordpress request served\\" >> /var/log/wordpress.log; sleep 3; done"]`,
        }),
    },
    checks: [
      { desc: 'Container sidecar uses busybox:stable', args: ['get', 'deploy', 'wordpress', '-n', 'sidecar', '-o', 'jsonpath={.spec.template.spec.containers[?(@.name=="sidecar")].image}'], expect: { eq: 'busybox:stable' } },
      { desc: 'Both containers mount the same volume at /var/log', args: ['get', 'deploy', 'wordpress', '-n', 'sidecar', '-o', 'jsonpath={.spec.template.spec.containers[?(@.name=="wordpress")].volumeMounts[?(@.mountPath=="/var/log")].name}={.spec.template.spec.containers[?(@.name=="sidecar")].volumeMounts[?(@.mountPath=="/var/log")].name}'], expect: { match: '^(.+)=\\1$' } },
      { desc: 'Deployment is available', args: ['get', 'deploy', 'wordpress', '-n', 'sidecar', '-o', 'jsonpath={.status.availableReplicas}'], expect: { eq: '1' } },
      { desc: 'Sidecar streams wordpress.log', args: ['logs', 'deploy/wordpress', '-n', 'sidecar', '-c', 'sidecar', '--tail=3'], expect: { contains: 'wordpress request served' } },
    ],
    hints: ['`kubectl -n sidecar edit deploy wordpress` — work in the Pod template (the second `spec:`), not the Deployment spec.', 'Three additions: a `volumes:` entry (`emptyDir: {}`), a `volumeMounts:` on the existing container, and the new container with the same mount.', 'Keep the new `- name: sidecar` at the same indentation as the existing container. For the command format, copy from the docs page "Sidecar Containers".'],
    solution: `# kubectl -n sidecar edit deploy wordpress, and add to spec.template.spec:
#   containers:
#   - name: wordpress
#     ...
#     volumeMounts:
#     - name: log-volume
#       mountPath: /var/log
#   - name: sidecar
#     image: busybox:stable
#     command: ["/bin/sh", "-c", "tail -f /var/log/wordpress.log"]
#     volumeMounts:
#     - name: log-volume
#       mountPath: /var/log
#   volumes:
#   - name: log-volume
#     emptyDir: {}
#
# the same change as a patch:
kubectl -n sidecar patch deploy wordpress -p '{"spec":{"template":{"spec":{"volumes":[{"name":"log-volume","emptyDir":{}}],"containers":[{"name":"wordpress","volumeMounts":[{"name":"log-volume","mountPath":"/var/log"}]},{"name":"sidecar","image":"busybox:stable","command":["/bin/sh","-c","tail -f /var/log/wordpress.log"],"volumeMounts":[{"name":"log-volume","mountPath":"/var/log"}]}]}}}}'

kubectl -n sidecar rollout status deploy/wordpress
kubectl -n sidecar describe deploy wordpress        # two containers, both with the mount
kubectl -n sidecar logs deploy/wordpress -c sidecar --tail=5`,
    cleanup: delNs('sidecar'),
    docs: `${DOCS}/concepts/workloads/pods/sidecar-containers/`,
    videos: [['CKA Exam | Question 3 | Sidecar', YT + '3xraEGGQJDY']],
  },
  {
    id: 'sc-resources',
    num: 'Q4',
    domain: 'work',
    title: 'Divide node resources between WordPress Pods',
    difficulty: 'Hard',
    minutes: 10,
    lab: true,
    scenario: `You manage a WordPress application whose Pods are not all running because of their resource requests. The \`wordpress\` Deployment in namespace \`wordpress\` has **3** replicas, each with an init container and a main container, and all replicas are scheduled onto the same node.

Adjust the requests and limits to ensure stable operation:

1. Scale the \`wordpress\` Deployment down to \`0\` replicas.
2. Edit the Deployment and divide the node's resources evenly across all 3 Pods: give each Pod a fair and equal share of CPU and memory, leaving enough overhead to keep the node stable.
3. Make sure the init container and the main container use **exactly the same** requests and limits.
4. Scale the Deployment back to \`3\` replicas.

All three Pods must end up running.`,
    setup: {
      yaml:
        ns('wordpress') +
        deploy({
          name: 'wordpress',
          namespace: 'wordpress',
          replicas: 3,
          image: BUSYBOX,
          podExtra: `
      affinity:
        podAffinity:
          requiredDuringSchedulingIgnoredDuringExecution:
          - labelSelector:
              matchLabels:
                app: wordpress
            topologyKey: kubernetes.io/hostname
      initContainers:
      - name: init-setup
        image: ${BUSYBOX}
        command: ["sh", "-c", "echo preparing wordpress; sleep 2"]
        resources:
          requests:
            cpu: 100m
            memory: 64Mi`,
          extra: `
        command: ["sh", "-c", "while true; do echo serving; sleep 30; done"]
        resources:
          requests:
            cpu: 1500m
            memory: 1Gi`,
        }),
    },
    checks: [
      { desc: 'Deployment is back at 3 replicas, all ready', args: ['get', 'deploy', 'wordpress', '-n', 'wordpress', '-o', 'jsonpath={.spec.replicas}/{.status.readyReplicas}'], expect: { eq: '3/3' } },
      { desc: 'Main container requests CPU and memory', args: ['get', 'deploy', 'wordpress', '-n', 'wordpress', '-o', 'jsonpath={.spec.template.spec.containers[0].resources.requests.cpu}/{.spec.template.spec.containers[0].resources.requests.memory}'], expect: { match: '^[^/]+/[^/]+$' } },
      {
        desc: 'Init container has exactly the same requests and limits',
        args: ['get', 'deploy', 'wordpress', '-n', 'wordpress', '-o', 'jsonpath={.spec.template.spec.containers[0].resources.requests.cpu},{.spec.template.spec.containers[0].resources.requests.memory},{.spec.template.spec.containers[0].resources.limits.cpu},{.spec.template.spec.containers[0].resources.limits.memory}={.spec.template.spec.initContainers[0].resources.requests.cpu},{.spec.template.spec.initContainers[0].resources.requests.memory},{.spec.template.spec.initContainers[0].resources.limits.cpu},{.spec.template.spec.initContainers[0].resources.limits.memory}'],
        expect: { match: '^(.+)=\\1$' },
      },
    ],
    hints: ['`kubectl -n wordpress get pods -o wide` shows the node; `kubectl describe node <node>` shows **Allocatable** and, further down, **Allocated resources**.', '1 CPU = `1000m`. Memory is listed in Ki: divide by 1024 for Mi.', 'Per Pod: (allocatable − 15…20% overhead − what other Pods already request) ÷ 3. It does not have to be exact; round down to something tidy.', 'The fields are documented under "Resource Management for Pods and Containers". Both `resources:` blocks live in the Pod template.'],
    solution: `kubectl -n wordpress get pods -o wide            # one replica Pending: Insufficient cpu
kubectl -n wordpress scale deploy wordpress --replicas=0

# what does the node have?
kubectl describe node <node>
#   Allocatable:  cpu 4, memory 16268928Ki   (≈ 15.5Gi)
#   CPU:    4000m - 20% = 3200m  / 3  ≈ 1000m per Pod
#   memory: 15.5Gi - 20% ≈ 12.4Gi / 3 ≈ 4Gi per Pod

# kubectl -n wordpress edit deploy wordpress — same block in the init and the main container:
#   resources:
#     requests:
#       cpu: "1"
#       memory: 4Gi
#     limits:
#       cpu: "1"
#       memory: 4Gi
# as a patch:
kubectl -n wordpress patch deploy wordpress -p '{"spec":{"template":{"spec":{"initContainers":[{"name":"init-setup","resources":{"requests":{"cpu":"1","memory":"4Gi"},"limits":{"cpu":"1","memory":"4Gi"}}}],"containers":[{"name":"wordpress","resources":{"requests":{"cpu":"1","memory":"4Gi"},"limits":{"cpu":"1","memory":"4Gi"}}}]}}}}'

kubectl -n wordpress scale deploy wordpress --replicas=3
kubectl -n wordpress rollout status deploy/wordpress
kubectl -n wordpress get pods -o wide
kubectl describe node <node>                     # Allocated resources now shows the three Pods`,
    cleanup: delNs('wordpress'),
    docs: `${DOCS}/concepts/configuration/manage-resources-containers/`,
    videos: [['CKA Exam Q4 Resource Allocation', YT + 'ZqGDdETii8c']],
  },
  {
    id: 'sc-crd',
    num: 'Q6',
    domain: 'arch',
    title: 'List the cert-manager CRDs and document a field',
    difficulty: 'Easy',
    minutes: 4,
    lab: true,
    scenario: `cert-manager's CustomResourceDefinitions are installed in the cluster.

- Create a list of all cert-manager CRDs and save it to \`resources.yaml\` (in the workspace folder; \`~/resources.yaml\` in the exam).
- Using \`kubectl\`, extract the documentation for the \`subject\` specification field of the \`Certificate\` custom resource and save it to \`subject.yaml\`.

You may use any output format that kubectl supports.

**Setup installs the cert-manager CRDs cluster-wide** (CRDs only, no controller) from the cert-manager release; they stay installed after cleanup.`,
    setup: {
      pre: [
        ['apply', '--server-side', '-f', CERT_MANAGER_CRDS],
        ['wait', '--for=condition=Established', 'crd/certificates.cert-manager.io', '--timeout=60s'],
      ],
    },
    checks: [
      { desc: 'resources.yaml lists the cert-manager CRDs', file: 'resources.yaml', expect: { contains: ['certificates.cert-manager.io', 'clusterissuers.cert-manager.io', 'issuers.cert-manager.io', 'certificaterequests.cert-manager.io'] } },
      { desc: 'subject.yaml documents Certificate spec.subject', file: 'subject.yaml', expect: { match: 'FIELD:\\s+subject[\\s\\S]*organizations' } },
    ],
    hints: ['In the exam: `kubectl get crd | grep cert-manager > ~/resources.yaml`. This console has no pipes — select by label instead (`kubectl get crd --show-labels`).', 'Documentation of a field is `kubectl explain <resource>.<path.to.field>`.', 'If another CRD with kind `Certificate` is installed (the Practice task on CRDs has one), name the group: `kubectl explain certificates.cert-manager.io.spec.subject`.'],
    solution: `# exam: kubectl get crd | grep cert-manager > ~/resources.yaml
kubectl get crd -l app.kubernetes.io/name=cert-manager > resources.yaml

kubectl explain certificates.cert-manager.io.spec.subject > subject.yaml`,
    cleanupFiles: ['resources.yaml', 'subject.yaml'],
    docs: `${DOCS}/tasks/extend-kubernetes/custom-resources/custom-resource-definitions/`,
    videos: [['CKA Exam Q-06 | Custom Resource Definitions (CRDs) | cert-manager Lab', YT + 'SA1DzLQaDJs']],
  },
  {
    id: 'sc-priority',
    num: 'Q7',
    domain: 'work',
    title: 'PriorityClass one below the highest',
    difficulty: 'Medium',
    minutes: 5,
    lab: true,
    scenario: `- Create a new PriorityClass named \`high-priority\` for user workloads, with a value that is **one less** than the highest existing user-defined PriorityClass value.
- Patch the existing Deployment \`busybox-logger\` in namespace \`priority\` to use the \`high-priority\` PriorityClass.
- Make sure the \`busybox-logger\` Deployment rolls out successfully with the new PriorityClass.

In the exam Pods of other Deployments in the namespace are expected to be evicted. Do not modify other Deployments in the namespace.

Setup creates the user-defined classes \`exam-low-priority\` and \`exam-medium-priority\`. Clean up the Practice task "PriorityClass for a critical workload" first if it is set up: its class would be the highest one.`,
    setup: {
      yaml:
        ns('priority') +
        `---
apiVersion: scheduling.k8s.io/v1
kind: PriorityClass
metadata:
  name: exam-low-priority
value: 100
globalDefault: false
description: User-defined, low.
---
apiVersion: scheduling.k8s.io/v1
kind: PriorityClass
metadata:
  name: exam-medium-priority
value: 1000
globalDefault: false
description: User-defined, currently the highest.
` +
        deploy({ name: 'busybox-logger', namespace: 'priority', image: BUSYBOX, extra: '\n        command: ["sh", "-c", "while true; do date; sleep 10; done"]' }),
    },
    checks: [
      { desc: 'PriorityClass high-priority has value 999', args: ['get', 'priorityclass', 'high-priority', '-o', 'jsonpath={.value}'], expect: { eq: '999' } },
      { desc: 'Deployment uses high-priority', args: ['get', 'deploy', 'busybox-logger', '-n', 'priority', '-o', 'jsonpath={.spec.template.spec.priorityClassName}'], expect: { eq: 'high-priority' } },
      { desc: 'Rollout finished: 1 updated replica available', args: ['get', 'deploy', 'busybox-logger', '-n', 'priority', '-o', 'jsonpath={.status.updatedReplicas}/{.status.availableReplicas}'], expect: { eq: '1/1' } },
      { desc: 'Running Pod got priority 999', args: ['get', 'pods', '-n', 'priority', '-l', 'app=busybox-logger', '--field-selector=status.phase=Running', '-o', 'jsonpath={.items[0].spec.priority}'], expect: { eq: '999' } },
    ],
    hints: ['`kubectl get pc` — the `system-*` classes are not user-defined; ignore them.', 'Copy the first manifest from the docs page "Pod Priority and Preemption" and change only the value, or use `kubectl create priorityclass`.', 'The patch has to be typed from memory: `spec.template.spec.priorityClassName` (capital C, capital N).'],
    solution: `kubectl get pc                                   # highest user-defined: 1000
kubectl create priorityclass high-priority --value=999 --description="user workloads"

kubectl -n priority patch deployment busybox-logger \\
  -p '{"spec":{"template":{"spec":{"priorityClassName":"high-priority"}}}}'

kubectl -n priority rollout status deploy/busybox-logger
kubectl -n priority get pods -o custom-columns=NAME:.metadata.name,CLASS:.spec.priorityClassName,PRIO:.spec.priority`,
    cleanup: [...delNs('priority'), ['delete', 'priorityclass', 'high-priority', 'exam-low-priority', 'exam-medium-priority', '--ignore-not-found']],
    docs: `${DOCS}/concepts/scheduling-eviction/pod-priority-preemption/`,
    videos: [['CKA 2025 | Q-7 - PriorityClass', YT + 'CZzxGyF6OHc']],
  },
  {
    id: 'sc-cni',
    num: 'Q8',
    domain: 'arch',
    title: 'Choose and install a CNI: Flannel or Calico',
    difficulty: 'Easy',
    minutes: 5,
    lab: false,
    scenario: `Install and configure a CNI of your choice that meets these requirements. You are given the manifest URLs of two candidates, **Flannel** and **Calico**:

- Pods must be able to communicate with each other.
- The CNI must support **NetworkPolicy** enforcement.
- Install it from the manifest, not with Helm.

**Practising locally:** replacing the CNI of a running cluster breaks it. Use a throwaway profile: \`minikube start -p cni-lab --cni=false --network-plugin=cni\`.`,
    hints: ['Only one of the two enforces NetworkPolicy — the requirement makes the choice for you.', 'You can prove it from the manifests: one of them never mentions NetworkPolicy.', 'Do not over-think it: apply the manifest, check the Pods and nodes, move on.'],
    solution: `# which manifest knows about NetworkPolicy?
curl -sL https://github.com/flannel-io/flannel/releases/download/v0.26.1/kube-flannel.yml | grep -i networkpolic   # nothing
curl -sL https://raw.githubusercontent.com/projectcalico/calico/v3.28.2/manifests/tigera-operator.yaml | grep -i networkpolic   # many hits

# → Calico. Use "create" for the operator: its CRDs are too large for the annotation "apply" adds
kubectl create -f https://raw.githubusercontent.com/projectcalico/calico/v3.28.2/manifests/tigera-operator.yaml

kubectl get pods -n tigera-operator
kubectl get nodes

# if the task also hands you custom-resources.yaml: set the pod CIDR to the cluster's, then create it
kubectl -n kube-system get cm kubeadm-config -o yaml | grep podSubnet`,
    docs: `${DOCS}/concepts/cluster-administration/addons/`,
    videos: [['CKA 2025 | Q-08 - CNI & Network Policy', YT + 'Uc04Ui4x3EM']],
  },
  {
    id: 'sc-cri-dockerd',
    num: 'Q9',
    domain: 'arch',
    title: 'Install cri-dockerd and set kernel parameters',
    difficulty: 'Medium',
    minutes: 6,
    lab: false,
    scenario: `Prepare a Linux system for Kubernetes. Docker is already installed, but you need to configure it for kubeadm.

- Install the Debian package \`~/cri-dockerd.deb\` using \`dpkg\`.
- Enable and start the \`cri-docker\` service.
- Configure these system parameters, persistently:
  - \`net.bridge.bridge-nf-call-iptables = 1\`
  - \`net.ipv6.conf.all.forwarding = 1\`
  - \`net.ipv4.ip_forward = 1\`
  - \`net.netfilter.nf_conntrack_max = 131072\`

**Practising locally:** try the sysctl part on a spare Linux VM, not on your minikube host.`,
    hints: ['`dpkg -i <file>` installs a local package; `ls ~` shows its exact file name.', 'Enable **and** start: two commands, or `systemctl enable --now`.', 'Persistent parameters go into a file under `/etc/sysctl.d/` (any name ending in `.conf`) and are loaded with `sysctl --system`.'],
    solution: `ls ~                                             # cri-dockerd_<version>.deb
sudo dpkg -i ~/cri-dockerd.deb

sudo systemctl enable cri-docker.service
sudo systemctl start cri-docker.service
systemctl status cri-docker.service              # active (running)

cat <<EOF | sudo tee /etc/sysctl.d/cka.conf
net.bridge.bridge-nf-call-iptables = 1
net.ipv6.conf.all.forwarding = 1
net.ipv4.ip_forward = 1
net.netfilter.nf_conntrack_max = 131072
EOF

sudo sysctl --system                             # lists every file it applies, including yours
cat /etc/sysctl.d/cka.conf
sysctl net.ipv4.ip_forward`,
    docs: `${DOCS}/setup/production-environment/container-runtimes/`,
    videos: [['CKA 2025 | Question 9 | cri-dockerd', YT + 'ybzo1vXiqjU']],
  },
  {
    id: 'sc-taint',
    num: 'Q10',
    domain: 'work',
    title: 'Taint a node and schedule a tolerating Pod',
    difficulty: 'Easy',
    minutes: 5,
    lab: true,
    scenario: `- Add a taint to **one worker node** (\`node01\` in the exam; pick any worker here, see \`kubectl get nodes\`) so that no normal Pods can be scheduled on it: key \`permission\`, value \`granted\`, effect \`NoSchedule\`.
- Create a Pod \`nginx\` (image \`${NGINX}\`) in namespace \`taints\` with a toleration that matches the taint, so that it would be allowed onto that node.

Cleanup removes the \`permission\` taint from every node again.`,
    setup: { yaml: ns('taints') },
    checks: [
      { desc: 'A node is tainted permission=granted:NoSchedule', args: ['get', 'nodes', '-o', 'jsonpath={range .items[*]}{.spec.taints[?(@.key=="permission")].value}:{.spec.taints[?(@.key=="permission")].effect}{" "}{end}'], expect: { contains: 'granted:NoSchedule' } },
      { desc: 'Pod nginx tolerates the taint', args: ['get', 'pod', 'nginx', '-n', 'taints', '-o', 'jsonpath={.spec.tolerations[?(@.key=="permission")].operator}:{.spec.tolerations[?(@.key=="permission")].value}:{.spec.tolerations[?(@.key=="permission")].effect}'], expect: { match: '^(Equal)?:granted:NoSchedule$' } },
      { desc: 'Pod nginx is Running', args: ['get', 'pod', 'nginx', '-n', 'taints', '-o', 'jsonpath={.status.phase}'], expect: { eq: 'Running' } },
    ],
    hints: ['`kubectl taint nodes <node> key=value:Effect` — the docs page "Taints and Tolerations" opens with exactly this command.', 'The same page has a Pod manifest with a `tolerations:` block; change key, value and effect. `operator: Equal` compares the value.', 'To see the taint work, pin a Pod without a toleration to that node (`nodeSelector: kubernetes.io/hostname`): it stays Pending.'],
    solution: `kubectl get nodes
kubectl taint nodes ${PROFILE}-m03 permission=granted:NoSchedule
kubectl describe node ${PROFILE}-m03               # Taints: permission=granted:NoSchedule

kubectl apply -f - <<EOF
apiVersion: v1
kind: Pod
metadata:
  name: nginx
  namespace: taints
spec:
  containers:
  - name: nginx
    image: ${NGINX}
  tolerations:
  - key: permission
    operator: Equal
    value: granted
    effect: NoSchedule
EOF
kubectl -n taints get pod nginx -o wide

# remove the taint again: kubectl taint nodes ${PROFILE}-m03 permission-`,
    cleanup: [...delNs('taints'), ['taint', 'nodes', '--all', 'permission-']],
    docs: `${DOCS}/concepts/scheduling-eviction/taint-and-toleration/`,
    videos: [['CKA Exam 2025 Q-10: Taints & Tolerations Made EASY', YT + 'oy6Mdqt1-jk']],
  },
  {
    id: 'sc-gateway',
    num: 'Q11',
    domain: 'net',
    title: 'Migrate the web Ingress to the Gateway API',
    difficulty: 'Hard',
    minutes: 10,
    lab: true,
    scenario: `Migrate an existing web application from Ingress to the Gateway API, keeping HTTPS access. A GatewayClass named \`nginx-class\` is already installed. The Ingress \`web\` lives in namespace \`gateway-migration\`.

- Create a Gateway named \`web-gateway\` with hostname \`gateway.web.k8s.local\` that maintains the existing TLS and listener configuration of the Ingress \`web\`.
- Create an HTTPRoute named \`web-route\` with hostname \`gateway.web.k8s.local\` that maintains the existing routing rules of the Ingress \`web\`.

**Setup installs the Gateway API CRDs (standard channel) cluster-wide** from the kubernetes-sigs release; they stay installed after cleanup. No gateway controller runs, so the Gateway will not get an address — the checks validate your spec.`,
    setup: {
      pre: [
        ['apply', '-f', GATEWAY_CRDS],
        ['wait', '--for=condition=Established', 'crd/gateways.gateway.networking.k8s.io', 'crd/httproutes.gateway.networking.k8s.io', 'crd/gatewayclasses.gateway.networking.k8s.io', '--timeout=60s'],
      ],
      yaml:
        ns('gateway-migration') +
        deploy({ name: 'web', namespace: 'gateway-migration' }) +
        `---
apiVersion: v1
kind: Service
metadata:
  name: web-service
  namespace: gateway-migration
spec:
  selector:
    app: web
  ports:
  - port: 8080
    targetPort: 80
---
apiVersion: v1
kind: Secret
metadata:
  name: web-tls
  namespace: gateway-migration
type: kubernetes.io/tls
stringData:
  tls.crt: |
${indent(PRACTICE_TLS_CRT, 4)}
  tls.key: |
${indent(PRACTICE_TLS_KEY, 4)}
---
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: web
  namespace: gateway-migration
spec:
  ingressClassName: nginx
  tls:
  - hosts:
    - gateway.web.k8s.local
    secretName: web-tls
  rules:
  - host: gateway.web.k8s.local
    http:
      paths:
      - path: /
        pathType: Prefix
        backend:
          service:
            name: web-service
            port:
              number: 8080
---
apiVersion: gateway.networking.k8s.io/v1
kind: GatewayClass
metadata:
  name: nginx-class
spec:
  controllerName: gateway.nginx.org/nginx-gateway-controller
`,
    },
    checks: [
      { desc: 'Gateway uses GatewayClass nginx-class', args: ['get', 'gateways.gateway.networking.k8s.io', 'web-gateway', '-n', 'gateway-migration', '-o', 'jsonpath={.spec.gatewayClassName}'], expect: { eq: 'nginx-class' } },
      { desc: 'Listener is HTTPS on 443 for the hostname', args: ['get', 'gateways.gateway.networking.k8s.io', 'web-gateway', '-n', 'gateway-migration', '-o', 'jsonpath={.spec.listeners[0].protocol}:{.spec.listeners[0].port}:{.spec.listeners[0].hostname}'], expect: { eq: 'HTTPS:443:gateway.web.k8s.local' } },
      { desc: 'TLS terminates with Secret web-tls', args: ['get', 'gateways.gateway.networking.k8s.io', 'web-gateway', '-n', 'gateway-migration', '-o', 'jsonpath={.spec.listeners[0].tls.mode}:{.spec.listeners[0].tls.certificateRefs[0].name}'], expect: { match: '^(Terminate)?:web-tls$' } },
      { desc: 'HTTPRoute is attached to web-gateway', args: ['get', 'httproutes.gateway.networking.k8s.io', 'web-route', '-n', 'gateway-migration', '-o', 'jsonpath={.spec.parentRefs[0].name}'], expect: { eq: 'web-gateway' } },
      { desc: 'HTTPRoute hostname matches', args: ['get', 'httproutes.gateway.networking.k8s.io', 'web-route', '-n', 'gateway-migration', '-o', 'jsonpath={.spec.hostnames[0]}'], expect: { eq: 'gateway.web.k8s.local' } },
      { desc: 'Route sends / to web-service:8080', args: ['get', 'httproutes.gateway.networking.k8s.io', 'web-route', '-n', 'gateway-migration', '-o', 'jsonpath={.spec.rules[0].matches[0].path.value}:{.spec.rules[0].backendRefs[0].name}:{.spec.rules[0].backendRefs[0].port}'], expect: { eq: '/:web-service:8080' } },
    ],
    hints: ['Collect four facts first: `kubectl -n gateway-migration describe ingress web` gives host, path, backend Service and port; the TLS Secret is named there too.', 'Docs page "Gateway API": copy the Gateway example, then the HTTPRoute example. Change names, class, hostname; add the `tls:` block to the listener.', 'In `certificateRefs` the kind is `Secret` with a capital S. The route\'s `parentRefs` names your Gateway.'],
    solution: `kubectl -n gateway-migration describe ingress web      # host, path /, web-service:8080, TLS web-tls
kubectl -n gateway-migration describe secret web-tls
kubectl get gatewayclass

kubectl apply -f - <<EOF
apiVersion: gateway.networking.k8s.io/v1
kind: Gateway
metadata:
  name: web-gateway
  namespace: gateway-migration
spec:
  gatewayClassName: nginx-class
  listeners:
  - name: https
    protocol: HTTPS
    port: 443
    hostname: gateway.web.k8s.local
    tls:
      mode: Terminate
      certificateRefs:
      - kind: Secret
        name: web-tls
---
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: web-route
  namespace: gateway-migration
spec:
  parentRefs:
  - name: web-gateway
  hostnames:
  - gateway.web.k8s.local
  rules:
  - matches:
    - path:
        type: PathPrefix
        value: /
    backendRefs:
    - name: web-service
      port: 8080
EOF
kubectl -n gateway-migration describe gateway web-gateway
kubectl -n gateway-migration describe httproute web-route`,
    cleanup: [...delNs('gateway-migration'), ['delete', 'gatewayclasses.gateway.networking.k8s.io', 'nginx-class', '--ignore-not-found']],
    docs: `${DOCS}/concepts/services-networking/gateway/`,
    videos: [['CKA Question 11 - Gateway API | Migrate Your Ingress', YT + 'G9zispvOCHE']],
  },
  {
    id: 'sc-ingress',
    num: 'Q12',
    domain: 'net',
    title: 'Expose the echo Deployment through an Ingress',
    difficulty: 'Medium',
    minutes: 7,
    lab: true,
    scenario: `The Deployment \`echo\` runs in namespace \`echo-sound\`.

- Expose the Deployment with a Service named \`echo-service\`: port \`8080\`, type \`NodePort\`.
- Create an Ingress named \`echo\` in namespace \`echo-sound\` that makes the Service reachable at \`http://example.org/echo\`.

In the exam you verify with \`curl -o /dev/null -s -w "%{http_code}\\n" http://example.org/echo\`, which must print \`200\`. Here no ingress controller is required: the checks validate the Service, its endpoints and the Ingress rule.`,
    setup: {
      yaml:
        ns('echo-sound') +
        deploy({
          name: 'echo',
          namespace: 'echo-sound',
          image: 'registry.k8s.io/e2e-test-images/agnhost:2.53',
          extra: `
        args: ["netexec", "--http-port=8080"]`,
        }),
    },
    checks: [
      { desc: 'Service echo-service is a NodePort', args: ['get', 'svc', 'echo-service', '-n', 'echo-sound', '-o', 'jsonpath={.spec.type}'], expect: { eq: 'NodePort' } },
      { desc: 'Service port 8080 → container port 8080', args: ['get', 'svc', 'echo-service', '-n', 'echo-sound', '-o', 'jsonpath={.spec.ports[0].port}:{.spec.ports[0].targetPort}'], expect: { eq: '8080:8080' } },
      { desc: 'Service has endpoints', args: ['get', 'endpointslices', '-n', 'echo-sound', '-l', 'kubernetes.io/service-name=echo-service', '-o', 'jsonpath={.items[*].endpoints[*].addresses[*]}'], expect: { nonEmpty: true } },
      { desc: 'Ingress echo is for host example.org', args: ['get', 'ingress', 'echo', '-n', 'echo-sound', '-o', 'jsonpath={.spec.rules[0].host}'], expect: { eq: 'example.org' } },
      { desc: '/echo → echo-service:8080', args: ['get', 'ingress', 'echo', '-n', 'echo-sound', '-o', 'jsonpath={range .spec.rules[0].http.paths[?(@.path=="/echo")]}{.backend.service.name}:{.backend.service.port.number}{end}'], expect: { eq: 'echo-service:8080' } },
    ],
    hints: ['`kubectl expose deploy echo` does the Service in one line: `--name`, `--port`, `--target-port`, `--type`.', 'For the Ingress copy the first manifest from the docs page "Ingress" — or `kubectl create ingress echo --rule="host/path=svc:port"`.', 'Do not forget `namespace: echo-sound` in the Ingress; drop `ingressClassName` unless the task names one.'],
    solution: `kubectl -n echo-sound get deploy
kubectl -n echo-sound expose deploy echo --name=echo-service \\
  --port=8080 --target-port=8080 --type=NodePort
kubectl -n echo-sound get svc

kubectl apply -f - <<EOF
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: echo
  namespace: echo-sound
spec:
  rules:
  - host: example.org
    http:
      paths:
      - path: /echo
        pathType: Prefix
        backend:
          service:
            name: echo-service
            port:
              number: 8080
EOF
kubectl -n echo-sound describe ingress echo
# exam: curl -o /dev/null -s -w "%{http_code}\\n" http://example.org/echo   → 200`,
    cleanup: delNs('echo-sound'),
    docs: `${DOCS}/concepts/services-networking/ingress/`,
    videos: [['CKA Question 12 | Ingress Resources', YT + 'sy9zABvDedQ']],
  },
  {
    id: 'sc-netpol',
    num: 'Q13',
    domain: 'net',
    title: 'Pick the least permissive NetworkPolicy',
    difficulty: 'Easy',
    minutes: 5,
    lab: true,
    scenario: `There are two Deployments: \`frontend\` in namespace \`frontend\` and \`backend\` in namespace \`backend\`. A default-deny policy \`deny-all\` already protects the \`backend\` namespace.

Look at the NetworkPolicy manifests in the folder \`netpol/\` (workspace; \`~/netpol\` in the exam): \`netpol-1.yaml\`, \`netpol-2.yaml\`, \`netpol-3.yaml\`.

- Decide which **one** allows the frontend Deployment to reach the backend Deployment in the **least permissive** way, and apply that manifest.
- Do not modify or delete the existing \`deny-all\` policy, and do not apply the other manifests.`,
    setup: {
      files: {
        'netpol/netpol-1.yaml': netpol(
          'policy-x',
          `  podSelector: {}
  policyTypes:
  - Ingress
  ingress:
  - {}
`
        ),
        'netpol/netpol-2.yaml': netpol(
          'policy-y',
          `  podSelector:
    matchLabels:
      app: backend
  policyTypes:
  - Ingress
  ingress:
  - from:
    - namespaceSelector:
        matchLabels:
          kubernetes.io/metadata.name: frontend
    - ipBlock:
        cidr: 10.244.0.0/16
    ports:
    - protocol: TCP
      port: 80
`
        ),
        'netpol/netpol-3.yaml': netpol(
          'policy-z',
          `  podSelector:
    matchLabels:
      app: backend
  policyTypes:
  - Ingress
  ingress:
  - from:
    - namespaceSelector:
        matchLabels:
          kubernetes.io/metadata.name: frontend
      podSelector:
        matchLabels:
          app: frontend
    ports:
    - protocol: TCP
      port: 80
`
        ),
      },
      yaml:
        ns('frontend') +
        '---\n' +
        ns('backend') +
        deploy({ name: 'frontend', namespace: 'frontend' }) +
        deploy({ name: 'backend', namespace: 'backend' }) +
        `---
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: deny-all
  namespace: backend
spec:
  podSelector: {}
  policyTypes:
  - Ingress
`,
    },
    checks: [
      { desc: 'The least permissive policy is applied in backend', args: ['get', 'networkpolicy', '-n', 'backend', '-o', 'jsonpath={.items[*].metadata.name}'], expect: { match: '\\bpolicy-z\\b' } },
      { desc: 'The more permissive policies are not applied', args: ['get', 'networkpolicy', '-A', '-o', 'jsonpath={.items[*].metadata.name}'], expect: { notMatch: '\\bpolicy-[xy]\\b' } },
      { desc: 'deny-all is still in place, unchanged', args: ['get', 'networkpolicy', 'deny-all', '-n', 'backend', '-o', 'jsonpath={.spec.podSelector}{.spec.ingress}{.spec.policyTypes}'], expect: { eq: '{}["Ingress"]' } },
    ],
    hints: ['Open the three files from the YAML editor ("Open file…") and compare only the `ingress:` rules.', 'Red flags: an empty rule `- {}` (everyone, every port), an `ipBlock` with a wide CIDR (a /16 is 65,536 addresses), missing `ports`.', 'Two selectors in **one** `from` item are ANDed (this namespace *and* these Pods); as two items they are ORed.'],
    solution: `# netpol-1: ingress "- {}"            → any source, any port
# netpol-2: namespace frontend OR a /16  → 65,536 extra addresses
# netpol-3: namespace frontend AND pods app=frontend, TCP 80 only  → least permissive
kubectl apply -f netpol/netpol-3.yaml
kubectl -n backend get networkpolicy
kubectl -n backend describe networkpolicy policy-z`,
    cleanup: delNs('frontend', 'backend'),
    cleanupFiles: ['netpol'],
    docs: `${DOCS}/concepts/services-networking/network-policies/`,
    videos: [['CKA Question 13 | Network Policy', YT + 'rA8mXYTU0W8']],
  },
  {
    id: 'sc-storageclass',
    num: 'Q14',
    domain: 'stor',
    title: 'New StorageClass, then switch the default',
    difficulty: 'Medium',
    minutes: 5,
    lab: true,
    scenario: `- Create a new StorageClass named \`local-storage\` with the provisioner \`rancher.io/local-path\`. Set its \`volumeBindingMode\` to \`WaitForFirstConsumer\`. Do **not** make it the default in the manifest.
- Then **patch** the StorageClass \`local-storage\` to make it the default StorageClass.
- Ensure \`local-storage\` is the **only** default StorageClass.

Do not modify any existing Deployments or PersistentVolumeClaims. Cleanup deletes \`local-storage\` and marks minikube's \`standard\` class as default again.`,
    checks: [
      { desc: 'Provisioner is rancher.io/local-path', args: ['get', 'sc', 'local-storage', '-o', 'jsonpath={.provisioner}'], expect: { eq: 'rancher.io/local-path' } },
      { desc: 'volumeBindingMode is WaitForFirstConsumer', args: ['get', 'sc', 'local-storage', '-o', 'jsonpath={.volumeBindingMode}'], expect: { eq: 'WaitForFirstConsumer' } },
      { desc: 'local-storage is default', args: ['get', 'sc', 'local-storage', '-o', 'jsonpath={.metadata.annotations.storageclass\\.kubernetes\\.io/is-default-class}'], expect: { eq: 'true' } },
      { desc: 'It is the only default StorageClass', args: ['get', 'sc', '-o', 'jsonpath={range .items[*]}{.metadata.annotations.storageclass\\.kubernetes\\.io/is-default-class}{" "}{end}'], expect: { match: '^(?!(?:.*true){2}).*true' } },
    ],
    hints: ['Docs page "Storage Classes": copy the first manifest, remove `parameters` and anything else the task does not ask for.', 'The default marker is the annotation `storageclass.kubernetes.io/is-default-class` — `kubectl get sc <current-default> -o yaml` shows it, ready to copy into the patch.', 'Run the patch twice: `"true"` on `local-storage`, `"false"` on the old default. `kubectl get sc` shows `(default)` next to exactly one class.'],
    solution: `kubectl get sc                                   # standard (default)
kubectl apply -f - <<EOF
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: local-storage
provisioner: rancher.io/local-path
volumeBindingMode: WaitForFirstConsumer
EOF

kubectl patch storageclass local-storage \\
  -p '{"metadata":{"annotations":{"storageclass.kubernetes.io/is-default-class":"true"}}}'
kubectl patch storageclass standard \\
  -p '{"metadata":{"annotations":{"storageclass.kubernetes.io/is-default-class":"false"}}}'
kubectl get sc                                   # local-storage (default) only`,
    cleanup: [
      ['delete', 'sc', 'local-storage', '--ignore-not-found'],
      ['patch', 'sc', 'standard', '-p', DEFAULT_SC],
    ],
    docs: `${DOCS}/tasks/administer-cluster/change-default-storage-class/`,
    videos: [['CKA Question 14 - StorageClass | Change the Default StorageClass', YT + 'di7X7OHn2fc']],
  },
  {
    id: 'sc-apiserver',
    num: 'Q15',
    domain: 'trbl',
    title: 'kube-apiserver down: wrong etcd port',
    difficulty: 'Medium',
    minutes: 6,
    lab: false,
    scenario: `After a cluster migration, the control plane's kube-apiserver is not coming up. Before the migration etcd was external and highly available; after it, the kube-apiserver was left pointing at etcd on port \`2380\` — the peer port. Clients must use \`2379\`.

Fix it and make sure the cluster is healthy again.

**Practising locally:** on a **throwaway** cluster, \`minikube ssh\`, change \`--etcd-servers\` in \`/etc/kubernetes/manifests/kube-apiserver.yaml\` to port 2380, watch the API server crash-loop, then repair it.`,
    hints: ['`kubectl get nodes` answers `connection refused`: the API server itself is down, so kubectl cannot help. Work with `crictl` on the node.', '`crictl ps -a | grep kube-apiserver` — the container keeps restarting, so its ID changes; grab a fresh one for `crictl logs`.', 'The log names the address it cannot reach. The flag lives in the static Pod manifest; the kubelet restarts the Pod when you save the file. Give it a minute.'],
    solution: `kubectl get nodes                                # connection refused
crictl ps -a | grep kube-apiserver               # Exited, restarting over and over
crictl logs <container-id>                       # ... dial tcp 127.0.0.1:2380: connect: connection refused

cd /etc/kubernetes/manifests
grep -n etcd-servers kube-apiserver.yaml
vi kube-apiserver.yaml
#   - --etcd-servers=https://127.0.0.1:2379      (was :2380)

# the kubelet recreates the static Pod — wait for it
crictl ps -a | grep kube-apiserver               # Running
kubectl get nodes                                # Ready`,
    docs: `${DOCS}/tasks/debug/debug-cluster/`,
    videos: [
      ['CKA Question 15 - Troubleshooting: kube-apiserver Down? Fix Wrong etcd Port', YT + 'IL448T6r8H4'],
      ['CKA Exam Prep | Kubernetes Troubleshooting (two-minute recap)', YT + 'gQpVH2cNK3U'],
    ],
  },
  {
    id: 'sc-nodeport',
    num: 'Q16',
    domain: 'net',
    title: 'NodePort Service on port 80/TCP',
    difficulty: 'Easy',
    minutes: 5,
    lab: true,
    scenario: `There is a Deployment named \`nodeport-deployment\` in namespace \`relative\`.

- Configure the Deployment so that it exposes container port \`80\`, with the name \`http\` and protocol \`TCP\`.
- Create a new Service named \`nodeport-service\` exposing container port \`80\`, protocol \`TCP\`, node port \`30080\`.
- The Service must expose the individual Pods of the Deployment using \`NodePort\`.

Node port \`30080\` can be used only once per cluster: clean up the Practice task "Expose a Deployment with a NodePort Service" first if it is set up.`,
    setup: { yaml: ns('relative') + deploy({ name: 'nodeport-deployment', namespace: 'relative', replicas: 2 }) },
    checks: [
      { desc: 'Container port 80 is named http, protocol TCP', args: ['get', 'deploy', 'nodeport-deployment', '-n', 'relative', '-o', 'jsonpath={.spec.template.spec.containers[0].ports[?(@.containerPort==80)].name}/{.spec.template.spec.containers[0].ports[?(@.containerPort==80)].protocol}'], expect: { eq: 'http/TCP' } },
      { desc: 'Service type is NodePort', args: ['get', 'svc', 'nodeport-service', '-n', 'relative', '-o', 'jsonpath={.spec.type}'], expect: { eq: 'NodePort' } },
      { desc: 'Port 80/TCP on node port 30080', args: ['get', 'svc', 'nodeport-service', '-n', 'relative', '-o', 'jsonpath={.spec.ports[0].port}/{.spec.ports[0].protocol}:{.spec.ports[0].nodePort}'], expect: { eq: '80/TCP:30080' } },
      { desc: 'Service targets container port 80', args: ['get', 'svc', 'nodeport-service', '-n', 'relative', '-o', 'jsonpath={.spec.ports[0].targetPort}'], expect: { match: '^(80|http)$' } },
      { desc: 'Service selects the Deployment\'s Pods', args: ['get', 'endpointslices', '-n', 'relative', '-l', 'kubernetes.io/service-name=nodeport-service', '-o', 'jsonpath={.items[*].endpoints[*].addresses[*]}'], expect: { nonEmpty: true } },
    ],
    hints: ['`kubectl -n relative edit deploy nodeport-deployment`: add `ports:` under the container with `name`, `containerPort` and `protocol`.', 'Docs page "Service" → type NodePort has the manifest. Set name, **namespace**, `nodePort: 30080`.', 'The selector must match the Pod labels: `kubectl -n relative get deploy nodeport-deployment --show-labels` or `get pods --show-labels`.'],
    solution: `# kubectl -n relative edit deploy nodeport-deployment, under the container:
#   ports:
#   - name: http
#     containerPort: 80
#     protocol: TCP
# as a patch:
kubectl -n relative patch deploy nodeport-deployment --type json \\
  -p '[{"op":"add","path":"/spec/template/spec/containers/0/ports","value":[{"name":"http","containerPort":80,"protocol":"TCP"}]}]'

kubectl -n relative get pods --show-labels       # app=nodeport-deployment
kubectl apply -f - <<EOF
apiVersion: v1
kind: Service
metadata:
  name: nodeport-service
  namespace: relative
spec:
  type: NodePort
  selector:
    app: nodeport-deployment
  ports:
  - port: 80
    targetPort: 80
    protocol: TCP
    nodePort: 30080
EOF
kubectl -n relative get svc,endpointslices
kubectl get nodes -o wide                        # exam: curl http://<node-ip>:30080`,
    cleanup: delNs('relative'),
    docs: `${DOCS}/concepts/services-networking/service/#type-nodeport`,
    videos: [['CKA Question 16 | NodePort Setup on Port 80 TCP', YT + 'UT-RZCZlUiw']],
  },
  {
    id: 'sc-tls',
    num: 'Q17',
    domain: 'work',
    title: 'Allow only TLS 1.3 on nginx-static',
    difficulty: 'Medium',
    minutes: 7,
    lab: true,
    scenario: `There is an existing Deployment \`nginx-static\` in namespace \`nginx-static\`. It is configured by the ConfigMap \`nginx-config\`, which supports \`TLSv1.2\` and \`TLSv1.3\`, and uses the TLS Secret \`nginx-tls\`. The Service \`nginx-service\` in the same namespace exposes the Deployment.

- Configure the ConfigMap to support **only \`TLSv1.3\`**, and make sure the running Pods use the new configuration.
- In the exam you then add the Service's IP address to \`/etc/hosts\` under the name \`ckaquestion.k8s.local\` and verify with curl: \`curl -k --tls-max 1.2 https://ckaquestion.k8s.local\` must fail, \`curl -k --tlsv1.3 https://ckaquestion.k8s.local\` must work.

This console has no shell for the \`/etc/hosts\` step, so the checks run the same two curl commands inside a Pod.`,
    setup: {
      yaml:
        ns('nginx-static') +
        `---
apiVersion: v1
kind: Secret
metadata:
  name: nginx-tls
  namespace: nginx-static
type: kubernetes.io/tls
stringData:
  tls.crt: |
${indent(PRACTICE_TLS_CRT, 4)}
  tls.key: |
${indent(PRACTICE_TLS_KEY, 4)}
---
apiVersion: v1
kind: ConfigMap
metadata:
  name: nginx-config
  namespace: nginx-static
data:
  default.conf: |
    server {
      listen 443 ssl;
      server_name ckaquestion.k8s.local;
      ssl_certificate /etc/nginx/tls/tls.crt;
      ssl_certificate_key /etc/nginx/tls/tls.key;
      ssl_protocols TLSv1.2 TLSv1.3;
      location / {
        return 200 "nginx-static ok\\n";
      }
    }
---
apiVersion: v1
kind: Service
metadata:
  name: nginx-service
  namespace: nginx-static
spec:
  selector:
    app: nginx-static
  ports:
  - port: 443
    targetPort: 443
` +
        deploy({
          name: 'nginx-static',
          namespace: 'nginx-static',
          extra: `
        ports:
        - containerPort: 443
        volumeMounts:
        - name: config
          mountPath: /etc/nginx/conf.d/default.conf
          subPath: default.conf
        - name: tls
          mountPath: /etc/nginx/tls
          readOnly: true
      volumes:
      - name: config
        configMap:
          name: nginx-config
      - name: tls
        secret:
          secretName: nginx-tls`,
        }),
    },
    checks: [
      { desc: 'ConfigMap no longer mentions TLSv1.2', args: ['get', 'cm', 'nginx-config', '-n', 'nginx-static', '-o', 'jsonpath={.data.default\\.conf}'], expect: { notMatch: 'TLSv1\\.2' } },
      { desc: 'ConfigMap allows TLSv1.3', args: ['get', 'cm', 'nginx-config', '-n', 'nginx-static', '-o', 'jsonpath={.data.default\\.conf}'], expect: { match: 'ssl_protocols\\s+TLSv1\\.3\\s*;' } },
      { desc: 'curl --tls-max 1.2 is rejected (exit 35)', args: ['exec', 'deploy/nginx-static', '-n', 'nginx-static', '--', 'curl', '-sk', '--tls-max', '1.2', 'https://localhost'], expect: { exit: 35 } },
      { desc: 'curl --tlsv1.3 still works', args: ['exec', 'deploy/nginx-static', '-n', 'nginx-static', '--', 'curl', '-sk', '--tlsv1.3', 'https://localhost'], expect: { contains: 'nginx-static ok' } },
    ],
    hints: ['`kubectl -n nginx-static edit cm nginx-config` and remove `TLSv1.2` from `ssl_protocols`. If it had been created with `kubectl apply`, the old text also sits in the last-applied annotation; only the `data` matters.', 'Editing a ConfigMap does not restart anything, and a `subPath` mount never updates in place: `kubectl rollout restart` the Deployment.', 'Test without a shell: `kubectl -n nginx-static exec deploy/nginx-static -- curl -sk --tls-max 1.2 https://localhost`.'],
    solution: `kubectl -n nginx-static get deploy,cm,svc
kubectl -n nginx-static edit cm nginx-config
#   ssl_protocols TLSv1.3;                       (was: TLSv1.2 TLSv1.3)
kubectl -n nginx-static rollout restart deployment nginx-static
kubectl -n nginx-static rollout status deployment nginx-static

# exam: point a host name at the Service and test from the node
#   kubectl -n nginx-static get svc nginx-service            # CLUSTER-IP
#   echo "<cluster-ip> ckaquestion.k8s.local" | sudo tee -a /etc/hosts
#   curl -k --tls-max 1.2 https://ckaquestion.k8s.local      # fails: tlsv1 alert protocol version
#   curl -k --tlsv1.3 https://ckaquestion.k8s.local          # works
# here:
kubectl -n nginx-static exec deploy/nginx-static -- curl -sk --tls-max 1.2 https://localhost
kubectl -n nginx-static exec deploy/nginx-static -- curl -sk --tlsv1.3 https://localhost`,
    cleanup: delNs('nginx-static'),
    docs: `${DOCS}/concepts/configuration/configmap/`,
    videos: [['CKA Exam Question 17: TLS Configuration', YT + 'WFTVTi8JhKc']],
  },
];

module.exports = { scenarios, scenarioSource };
