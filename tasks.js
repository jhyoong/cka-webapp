// Task bank for the CKA practice lab.
// Domains and weights follow the official CNCF CKA curriculum v1.35; task themes follow
// what recent candidates report (Gateway API, HPA behavior, PriorityClass, sidecars, Helm,
// Kustomize, CRDs, cri-dockerd, CNI install, control-plane troubleshooting, ...).
//
// lab: true  -> runs on the local cluster with Setup / Verify / Clean up
// lab: false -> node-level walkthrough (kubeadm, etcd, kubelet...) with a reference solution

const NGINX = 'nginx:1.27-alpine';
const BUSYBOX = 'busybox:1.36';
const DOCS = 'https://kubernetes.io/docs';
// minikube profile behind the pinned context; minikube names its nodes <profile>, <profile>-m02, …
const PROFILE = process.env.MINIKUBE_PROFILE || process.env.KUBE_CONTEXT || 'minikube';

const domains = [
  {
    id: 'trbl',
    name: 'Troubleshooting',
    weight: 30,
    competencies: [
      'Troubleshoot clusters and nodes',
      'Troubleshoot cluster components',
      'Monitor cluster and application resource usage',
      'Manage and evaluate container output streams',
      'Troubleshoot services and networking',
    ],
  },
  {
    id: 'arch',
    name: 'Cluster Architecture, Installation & Configuration',
    weight: 25,
    competencies: [
      'Manage role based access control (RBAC)',
      'Prepare underlying infrastructure for installing a Kubernetes cluster',
      'Create and manage Kubernetes clusters using kubeadm',
      'Manage the lifecycle of Kubernetes clusters',
      'Implement and configure a highly-available control plane',
      'Use Helm and Kustomize to install cluster components',
      'Understand extension interfaces (CNI, CSI, CRI, etc.)',
      'Understand CRDs, install and configure operators',
    ],
  },
  {
    id: 'net',
    name: 'Services & Networking',
    weight: 20,
    competencies: [
      'Understand connectivity between Pods',
      'Define and enforce Network Policies',
      'Use ClusterIP, NodePort, LoadBalancer service types and endpoints',
      'Use the Gateway API to manage Ingress traffic',
      'Know how to use Ingress controllers and Ingress resources',
      'Understand and use CoreDNS',
    ],
  },
  {
    id: 'work',
    name: 'Workloads & Scheduling',
    weight: 15,
    competencies: [
      'Understand application deployments and how to perform rolling update and rollbacks',
      'Use ConfigMaps and Secrets to configure applications',
      'Configure workload autoscaling',
      'Understand the primitives used to create robust, self-healing, application deployments',
      'Configure Pod admission and scheduling (limits, node affinity, etc.)',
    ],
  },
  {
    id: 'stor',
    name: 'Storage',
    weight: 10,
    competencies: [
      'Implement storage classes and dynamic volume provisioning',
      'Configure volume types, access modes and reclaim policies',
      'Manage persistent volumes and persistent volume claims',
    ],
  },
];

const ns = (name) => `apiVersion: v1
kind: Namespace
metadata:
  name: ${name}
`;

const deploy = ({ name, namespace, replicas = 1, image = NGINX, labels, extra = '', podExtra = '' }) => `---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: ${name}
  namespace: ${namespace}
spec:
  replicas: ${replicas}
  selector:
    matchLabels:
      app: ${labels || name}
  template:
    metadata:
      labels:
        app: ${labels || name}
    spec:${podExtra}
      containers:
      - name: ${name}
        image: ${image}${extra}
`;

const delNs = (...names) => names.map((n) => ['delete', 'namespace', n, '--ignore-not-found']);

const tasks = [
  // ───────────────────────── Troubleshooting (30%) ─────────────────────────
  {
    id: 'trbl-image',
    domain: 'trbl',
    title: 'Deployment stuck: no pods become ready',
    difficulty: 'Easy',
    minutes: 4,
    lab: true,
    scenario: `The Deployment \`inventory\` in namespace \`trbl-image\` should run **3** ready replicas, but none of them come up.

Find out why and fix the Deployment. Do not delete and recreate it.`,
    setup: { yaml: ns('trbl-image') + deploy({ name: 'inventory', namespace: 'trbl-image', replicas: 3, image: 'nginx:1.27-alpin' }) },
    checks: [
      { desc: '3 replicas are ready', args: ['get', 'deploy', 'inventory', '-n', 'trbl-image', '-o', 'jsonpath={.status.readyReplicas}'], expect: { eq: '3' } },
      { desc: 'Still an nginx image', args: ['get', 'deploy', 'inventory', '-n', 'trbl-image', '-o', 'jsonpath={.spec.template.spec.containers[0].image}'], expect: { match: '^nginx:' } },
    ],
    hints: ['`kubectl get pods -n trbl-image` — what is the STATUS?', '`kubectl describe pod` shows the pull error in Events. Look closely at the image tag.'],
    solution: `kubectl -n trbl-image get pods                       # ImagePullBackOff / ErrImagePull
kubectl -n trbl-image describe pod -l app=inventory  # Events: nginx:1.27-alpin not found
kubectl -n trbl-image set image deploy/inventory inventory=nginx:1.27-alpine
kubectl -n trbl-image rollout status deploy/inventory`,
    cleanup: delNs('trbl-image'),
    docs: `${DOCS}/tasks/debug/debug-application/debug-pods/`,
  },
  {
    id: 'trbl-service',
    domain: 'trbl',
    title: 'Service has no endpoints',
    difficulty: 'Medium',
    minutes: 6,
    lab: true,
    scenario: `In namespace \`trbl-svc\` the Deployment \`catalog\` is healthy, but clients calling the Service \`catalog\` on port 80 get connection errors.

Fix the **Service** (there are two separate problems). Do not change the Deployment.`,
    setup: {
      yaml:
        ns('trbl-svc') +
        deploy({ name: 'catalog', namespace: 'trbl-svc', replicas: 2 }) +
        `---
apiVersion: v1
kind: Service
metadata:
  name: catalog
  namespace: trbl-svc
spec:
  selector:
    app: catalogue
  ports:
  - port: 80
    targetPort: 8080
`,
    },
    checks: [
      { desc: 'Service has ready endpoints', args: ['get', 'endpointslices', '-n', 'trbl-svc', '-l', 'kubernetes.io/service-name=catalog', '-o', 'jsonpath={.items[*].endpoints[*].addresses[*]}'], expect: { nonEmpty: true } },
      { desc: 'targetPort reaches nginx (80)', args: ['get', 'svc', 'catalog', '-n', 'trbl-svc', '-o', 'jsonpath={.spec.ports[0].targetPort}'], expect: { eq: '80' } },
      { desc: 'Service still listens on port 80', args: ['get', 'svc', 'catalog', '-n', 'trbl-svc', '-o', 'jsonpath={.spec.ports[0].port}'], expect: { eq: '80' } },
      { desc: 'Deployment labels unchanged', args: ['get', 'deploy', 'catalog', '-n', 'trbl-svc', '-o', 'jsonpath={.spec.template.metadata.labels.app}'], expect: { eq: 'catalog' } },
    ],
    hints: ['`kubectl get endpointslices -n trbl-svc` (or `kubectl describe svc catalog`) — empty endpoints mean the selector matches nothing.', 'Compare `kubectl get pods --show-labels` with the Service selector.', 'Once endpoints appear, check which port nginx actually listens on.'],
    solution: `kubectl -n trbl-svc describe svc catalog          # Endpoints: <none>
kubectl -n trbl-svc get pods --show-labels        # app=catalog (selector says catalogue)
kubectl -n trbl-svc patch svc catalog --type merge \\
  -p '{"spec":{"selector":{"app":"catalog"},"ports":[{"port":80,"targetPort":80}]}}'
kubectl -n trbl-svc get endpointslices
# test: kubectl -n trbl-svc run t --rm -i --restart=Never --image=busybox:1.36 -- wget -qO- -T 3 catalog`,
    cleanup: delNs('trbl-svc'),
    docs: `${DOCS}/tasks/debug/debug-application/debug-service/`,
  },
  {
    id: 'trbl-pending',
    domain: 'trbl',
    title: 'Pod stays Pending',
    difficulty: 'Medium',
    minutes: 6,
    lab: true,
    scenario: `The Pod \`report\` in namespace \`trbl-pending\` has been \`Pending\` since it was created.

Get it \`Running\` with the same name and image.
- You may **not** label or otherwise modify any node.
- The container's CPU request must end up at **500m or less**.`,
    setup: {
      yaml:
        ns('trbl-pending') +
        `---
apiVersion: v1
kind: Pod
metadata:
  name: report
  namespace: trbl-pending
spec:
  nodeSelector:
    tier: gold
  containers:
  - name: report
    image: ${BUSYBOX}
    command: ["sh", "-c", "sleep 1d"]
    resources:
      requests:
        cpu: "64"
        memory: 32Mi
`,
    },
    checks: [
      { desc: 'Pod report is Running', args: ['get', 'pod', 'report', '-n', 'trbl-pending', '-o', 'jsonpath={.status.phase}'], expect: { eq: 'Running' } },
      { desc: 'CPU request is 500m or less', args: ['get', 'pod', 'report', '-n', 'trbl-pending', '-o', 'jsonpath={.spec.containers[0].resources.requests.cpu}'], expect: { match: '^(|[1-9]\\d?m|[1-4]\\d\\dm|500m|0\\.[0-5]\\d*)$', allowFail: false } },
      { desc: 'Image unchanged', args: ['get', 'pod', 'report', '-n', 'trbl-pending', '-o', 'jsonpath={.spec.containers[0].image}'], expect: { eq: BUSYBOX } },
      { desc: 'No node was labelled tier=gold', args: ['get', 'nodes', '-l', 'tier=gold', '-o', 'name'], expect: { eq: '' } },
    ],
    hints: ['`kubectl describe pod report` — read the FailedScheduling event; it lists every reason nodes were rejected.', 'nodeSelector and resource requests are immutable on a running/pending Pod. Export the YAML, fix it, and replace the Pod.', '`kubectl replace --force -f file.yaml` deletes and recreates in one step.'],
    solution: `kubectl -n trbl-pending describe pod report
#  0/3 nodes are available: didn't match Pod's node affinity/selector, Insufficient cpu
kubectl -n trbl-pending get pod report -o yaml > report.yaml
# edit report.yaml: remove the nodeSelector block, set requests.cpu to e.g. 100m
kubectl replace --force -f report.yaml
kubectl -n trbl-pending get pod report`,
    cleanup: delNs('trbl-pending'),
    cleanupFiles: ['report.yaml'],
    docs: `${DOCS}/tasks/debug/debug-application/debug-running-pod/`,
  },
  {
    id: 'trbl-config',
    domain: 'trbl',
    title: 'Pod cannot start: missing configuration',
    difficulty: 'Medium',
    minutes: 7,
    lab: true,
    scenario: `The Pod \`orders\` in namespace \`trbl-config\` never reaches \`Running\`.

Fix the problem **without modifying or recreating the Pod**. When you are done the application must see \`DB_HOST=db.internal\`.`,
    setup: {
      yaml:
        ns('trbl-config') +
        `---
apiVersion: v1
kind: Pod
metadata:
  name: orders
  namespace: trbl-config
spec:
  containers:
  - name: orders
    image: ${BUSYBOX}
    command: ["sh", "-c", "echo DB_HOST=$DB_HOST; sleep 1d"]
    env:
    - name: DB_HOST
      valueFrom:
        configMapKeyRef:
          name: orders-config
          key: DB_HOST
    volumeMounts:
    - name: token
      mountPath: /etc/token
      readOnly: true
  volumes:
  - name: token
    secret:
      secretName: orders-token
`,
    },
    checks: [
      { desc: 'Pod orders is Running', args: ['get', 'pod', 'orders', '-n', 'trbl-config', '-o', 'jsonpath={.status.phase}'], expect: { eq: 'Running' } },
      { desc: 'Application logged DB_HOST=db.internal', args: ['logs', 'orders', '-n', 'trbl-config'], expect: { contains: 'DB_HOST=db.internal' } },
      { desc: 'Secret orders-token exists', args: ['get', 'secret', 'orders-token', '-n', 'trbl-config', '-o', 'name'], expect: { nonEmpty: true } },
    ],
    hints: ['`kubectl describe pod orders` — the Events mention what cannot be found (there are two things).', 'A missing Secret volume keeps the Pod in ContainerCreating (FailedMount); a missing ConfigMap key gives CreateContainerConfigError.', 'Create the missing objects with the exact names and keys the Pod references. The kubelet retries on its own.'],
    solution: `kubectl -n trbl-config describe pod orders
#  MountVolume.SetUp failed for volume "token": secret "orders-token" not found
kubectl -n trbl-config create secret generic orders-token --from-literal=token=s3cr3t
#  then: Error: configmap "orders-config" not found
kubectl -n trbl-config create configmap orders-config --from-literal=DB_HOST=db.internal
kubectl -n trbl-config get pod orders           # kubelet retries; can take up to ~1-2 min
kubectl -n trbl-config logs orders`,
    cleanup: delNs('trbl-config'),
    docs: `${DOCS}/tasks/configure-pod-container/configure-pod-configmap/`,
  },
  {
    id: 'trbl-probe',
    domain: 'trbl',
    title: 'Rollout never finishes: readiness failing',
    difficulty: 'Medium',
    minutes: 6,
    lab: true,
    scenario: `In namespace \`trbl-probe\` the Deployment \`checkout\` shows \`0/2\` ready even though its containers are running and never restart.

Find the cause and fix it so both replicas become ready. The fix must keep a working readiness probe (do not simply delete it).`,
    setup: {
      yaml:
        ns('trbl-probe') +
        deploy({
          name: 'checkout',
          namespace: 'trbl-probe',
          replicas: 2,
          extra: `
        ports:
        - containerPort: 80
        readinessProbe:
          httpGet:
            path: /
            port: 8080
          periodSeconds: 3`,
        }),
    },
    checks: [
      { desc: '2 replicas are ready', args: ['get', 'deploy', 'checkout', '-n', 'trbl-probe', '-o', 'jsonpath={.status.readyReplicas}'], expect: { eq: '2' } },
      { desc: 'A readiness probe is still configured', args: ['get', 'deploy', 'checkout', '-n', 'trbl-probe', '-o', 'jsonpath={.spec.template.spec.containers[0].readinessProbe}'], expect: { nonEmpty: true } },
    ],
    hints: ['Running but not Ready = readiness probe failing. `kubectl describe pod` shows "Readiness probe failed: ... connection refused".', 'Which port does the probe use, and which port does nginx listen on?'],
    solution: `kubectl -n trbl-probe describe pod -l app=checkout   # Readiness probe failed: dial tcp ...:8080: connection refused
kubectl -n trbl-probe patch deploy checkout --type json \\
  -p '[{"op":"replace","path":"/spec/template/spec/containers/0/readinessProbe/httpGet/port","value":80}]'
kubectl -n trbl-probe rollout status deploy/checkout`,
    cleanup: delNs('trbl-probe'),
    docs: `${DOCS}/tasks/configure-pod-container/configure-liveness-readiness-startup-probes/`,
  },
  {
    id: 'trbl-logs',
    domain: 'trbl',
    title: 'Find the failing container in the logs',
    difficulty: 'Easy',
    minutes: 4,
    lab: true,
    scenario: `The Pod \`payments\` in namespace \`trbl-logs\` runs several containers. One of them reports an \`ERROR\`.

Save the **complete log of only that container** to the file \`payments-error.log\`.

In this console, \`> payments-error.log\` writes into the workspace folder (in the exam it would be a path like \`/opt/...\`).`,
    setup: {
      yaml:
        ns('trbl-logs') +
        `---
apiVersion: v1
kind: Pod
metadata:
  name: payments
  namespace: trbl-logs
spec:
  containers:
  - name: api
    image: ${BUSYBOX}
    command: ["sh", "-c", "while true; do echo 'INFO api healthy'; sleep 5; done"]
  - name: ledger
    image: ${BUSYBOX}
    command: ["sh", "-c", "echo 'INFO ledger starting'; echo 'ERROR code=E4217 ledger checksum mismatch'; sleep 1d"]
  - name: metrics
    image: ${BUSYBOX}
    command: ["sh", "-c", "while true; do echo 'INFO metrics healthy'; sleep 5; done"]
`,
    },
    checks: [
      { desc: 'payments-error.log contains the error line', file: 'payments-error.log', expect: { contains: 'E4217' } },
      { desc: 'File holds only the failing container\'s log', file: 'payments-error.log', expect: { notMatch: 'healthy' } },
    ],
    hints: ['`kubectl logs payments --all-containers --prefix` shows which container says what.', '`kubectl logs <pod> -c <container>` selects one container.'],
    solution: `kubectl -n trbl-logs logs payments --all-containers --prefix
kubectl -n trbl-logs logs payments -c ledger > payments-error.log
# useful variants: --previous (crashed container), --since=10m, --tail=50, -f`,
    cleanup: delNs('trbl-logs'),
    cleanupFiles: ['payments-error.log'],
    docs: `${DOCS}/reference/kubectl/generated/kubectl_logs/`,
  },
  {
    id: 'trbl-top',
    domain: 'trbl',
    title: 'Find the pod using the most CPU',
    difficulty: 'Easy',
    minutes: 4,
    lab: true,
    scenario: `Among the Pods labelled \`tier=jobs\` in namespace \`trbl-top\`, find the one consuming the most CPU and write **only its name** to the file \`top-pod.txt\`.

**Prerequisite:** this needs metrics-server. On minikube run \`minikube addons enable metrics-server -p ${PROFILE}\` in your own terminal, then wait about a minute after Setup for metrics to appear.`,
    setup: {
      yaml:
        ns('trbl-top') +
        ['api-7', 'batch-3', 'sync-9']
          .map(
            (n) => `---
apiVersion: v1
kind: Pod
metadata:
  name: ${n}
  namespace: trbl-top
  labels:
    tier: jobs
spec:
  containers:
  - name: main
    image: ${BUSYBOX}
    command: ["sh", "-c", "${n === 'batch-3' ? 'while true; do :; done' : 'sleep 1d'}"]
    resources:
      limits:
        cpu: 150m
        memory: 32Mi
`
          )
          .join(''),
    },
    checks: [{ desc: 'top-pod.txt names the busiest pod', file: 'top-pod.txt', expect: { match: '^\\s*batch-3\\s*$' } }],
    hints: ['`kubectl top pod -n trbl-top -l tier=jobs --sort-by=cpu`', 'Write the name with the YAML editor (Save as `top-pod.txt`), or use `-o name`-style output redirected to the file.'],
    solution: `kubectl -n trbl-top top pod -l tier=jobs --sort-by=cpu
# exam style:
#   kubectl top pod -l tier=jobs --sort-by=cpu --no-headers | head -1 | awk '{print $1}' > /opt/top-pod.txt
# here: save the name "batch-3" as top-pod.txt from the editor
# related: kubectl top node, kubectl top pod -A --sort-by=memory, kubectl top pod --containers`,
    cleanup: delNs('trbl-top'),
    cleanupFiles: ['top-pod.txt'],
    docs: `${DOCS}/reference/kubectl/generated/kubectl_top/`,
  },
  {
    id: 'trbl-controlplane',
    domain: 'trbl',
    title: 'Control plane is down (static pod manifests)',
    difficulty: 'Hard',
    minutes: 12,
    lab: false,
    scenario: `After a migration, \`kubectl\` on the control-plane node returns \`connection refused\`. Several things are broken across the **kube-apiserver**, **kube-controller-manager** and **kube-scheduler** static Pod manifests (reported variants: wrong etcd endpoint/port in the apiserver, wrong certificate path, a typo in a flag, CPU requests larger than the node).

Restore the cluster.

**Practising locally:** \`minikube ssh -p ${PROFILE}\` drops you on the control-plane node. Manifests live in \`/etc/kubernetes/manifests\`. Copy a manifest to \`/tmp\` first, break one flag, watch what happens, then repair it. Do this on a throwaway cluster.`,
    hints: ['With the API server down, kubectl is useless — work on the node with `crictl` and the kubelet journal.', 'The kubelet watches `/etc/kubernetes/manifests`. Saving a fixed manifest restarts the static Pod within seconds.', 'A YAML syntax error means the kubelet cannot create the Pod at all: no container in `crictl ps -a`, error only in `journalctl -u kubelet`.'],
    solution: `ssh controlplane && sudo -i

# 1. what is (not) running?
crictl ps -a | grep -E 'kube-apiserver|etcd|controller|scheduler'
crictl logs <container-id>                 # the last lines usually name the bad flag
journalctl -u kubelet --since "10 min ago" | grep -iE 'error|fail' | tail -20
ls /var/log/pods/ /var/log/containers/     # logs survive even when crictl shows nothing

# 2. inspect the manifests
cd /etc/kubernetes/manifests
grep -n etcd-servers kube-apiserver.yaml   # must be https://127.0.0.1:2379 (2380 is the peer port!)
grep -n -- '--client-ca-file\\|--etcd-cafile\\|--tls-cert-file' kube-apiserver.yaml
ls /etc/kubernetes/pki /etc/kubernetes/pki/etcd   # do the referenced files exist?
# hostPath volumes must expose every path used in the flags

# 3. typical fixes
#   kube-apiserver:          --etcd-servers=https://127.0.0.1:2379
#   kube-controller-manager: --kubeconfig=/etc/kubernetes/controller-manager.conf ; sane cpu request
#   kube-scheduler:          --kubeconfig=/etc/kubernetes/scheduler.conf ; fix image / flag typos

# 4. verify
watch crictl ps
kubectl get nodes
kubectl -n kube-system get pods
# symptoms once the API is back:
#   Deployments not creating Pods  -> controller-manager broken
#   Pods stuck Pending, no events  -> scheduler broken`,
    docs: `${DOCS}/tasks/debug/debug-cluster/`,
  },
  {
    id: 'trbl-node',
    domain: 'trbl',
    title: 'Worker node is NotReady',
    difficulty: 'Medium',
    minutes: 8,
    lab: false,
    scenario: `\`kubectl get nodes\` shows a worker node as \`NotReady\`. Bring it back to \`Ready\` and make sure the fix survives a reboot.

Reported causes: kubelet stopped or disabled, wrong path/option in the kubelet config, wrong CA file, container runtime stopped, wrong API server address in \`/etc/kubernetes/kubelet.conf\`.

**Practising locally:** \`minikube ssh -p ${PROFILE} -n ${PROFILE}-m02\`, then \`sudo systemctl stop kubelet\` and watch the node go NotReady (takes ~40s). Fix it the way you would in the exam.`,
    hints: ['Order of investigation: `kubectl describe node` → ssh → `systemctl status kubelet` → `journalctl -u kubelet`.', '"Survives a reboot" means `systemctl enable`, not just `start`.'],
    solution: `kubectl get nodes
kubectl describe node <node>          # Conditions: "Kubelet stopped posting node status"

ssh <node> && sudo -i
systemctl status kubelet              # inactive? failed? which drop-in files?
journalctl -u kubelet -n 50 --no-pager

# kubelet stopped
systemctl enable --now kubelet

# bad config: files to compare against a healthy node
cat /var/lib/kubelet/config.yaml                              # clientCAFile, staticPodPath, cgroupDriver
cat /var/lib/kubelet/kubeadm-flags.env                        # --container-runtime-endpoint, --pod-infra-container-image
cat /etc/kubernetes/kubelet.conf                              # server: https://<cp>:6443
cat /usr/lib/systemd/system/kubelet.service.d/10-kubeadm.conf # ExecStart path (/usr/bin/kubelet)
systemctl daemon-reload && systemctl restart kubelet

# runtime down
systemctl status containerd && systemctl enable --now containerd
crictl ps

# disk / memory pressure
df -h; free -m

exit
kubectl get nodes -w`,
    docs: `${DOCS}/tasks/debug/debug-cluster/`,
  },
  {
    id: 'trbl-dns',
    domain: 'trbl',
    title: 'Cluster DNS / kube-proxy is broken',
    difficulty: 'Medium',
    minutes: 8,
    lab: false,
    scenario: `Pods can reach each other by IP, but resolving Service names fails (or ClusterIPs stop working on some nodes).

Restore name resolution and Service connectivity.

**Practising locally** (throwaway cluster only): \`kubectl -n kube-system scale deploy coredns --replicas=0\`, observe the failure from a test Pod, then repair it. The lab task "Resolve a Service through CoreDNS" lets you practise the test commands safely.`,
    hints: ['Split the problem: does `nslookup kubernetes.default` fail (DNS) or does `wget <cluster-ip>` fail (kube-proxy / NetworkPolicy)?', 'Pods get their resolver from the kubelet: `/etc/resolv.conf` should point at the `kube-dns` Service IP.'],
    solution: `# test from inside the cluster
kubectl run t --rm -i --restart=Never --image=busybox:1.36 -- nslookup kubernetes.default
kubectl run t --rm -i --restart=Never --image=busybox:1.36 -- cat /etc/resolv.conf

# CoreDNS
kubectl -n kube-system get deploy,pods -l k8s-app=kube-dns
kubectl -n kube-system logs -l k8s-app=kube-dns
kubectl -n kube-system get svc kube-dns                     # ClusterIP must match clusterDNS in kubelet config
kubectl -n kube-system get endpointslices -l k8s-app=kube-dns
kubectl -n kube-system get cm coredns -o yaml               # Corefile typos -> CrashLoopBackOff
kubectl -n kube-system scale deploy coredns --replicas=2
kubectl -n kube-system rollout restart deploy coredns

# kube-proxy (ClusterIP / NodePort not working)
kubectl -n kube-system get ds kube-proxy
kubectl -n kube-system logs ds/kube-proxy
kubectl -n kube-system get cm kube-proxy -o yaml            # mode, clusterCIDR, kubeconfig path

# don't forget NetworkPolicies: a default-deny egress policy also blocks DNS (UDP/TCP 53)
kubectl get netpol -A`,
    docs: `${DOCS}/tasks/administer-cluster/dns-debugging-resolution/`,
  },

  // ───────────────── Cluster Architecture, Installation & Configuration (25%) ─────────────────
  {
    id: 'arch-rbac-sa',
    domain: 'arch',
    title: 'RBAC: ServiceAccount, Role and RoleBinding',
    difficulty: 'Easy',
    minutes: 5,
    lab: true,
    scenario: `A CI pipeline needs limited access to namespace \`arch-rbac\`.

- Create a ServiceAccount \`deploy-bot\` in \`arch-rbac\`.
- Create a Role \`deploy-manager\` that allows **only** \`create\`, \`get\` and \`list\` on **Deployments**.
- Bind it to the ServiceAccount with a RoleBinding named \`deploy-bot-binding\`.

Verify your work with \`kubectl auth can-i\`.`,
    setup: { yaml: ns('arch-rbac') },
    checks: [
      { desc: 'deploy-bot can create deployments in arch-rbac', args: ['auth', 'can-i', 'create', 'deployments', '-n', 'arch-rbac', '--as=system:serviceaccount:arch-rbac:deploy-bot'], expect: { eq: 'yes' } },
      { desc: 'deploy-bot can list deployments', args: ['auth', 'can-i', 'list', 'deployments', '-n', 'arch-rbac', '--as=system:serviceaccount:arch-rbac:deploy-bot'], expect: { eq: 'yes' } },
      { desc: 'deploy-bot cannot delete deployments', args: ['auth', 'can-i', 'delete', 'deployments', '-n', 'arch-rbac', '--as=system:serviceaccount:arch-rbac:deploy-bot'], expect: { eq: 'no', allowFail: true } },
      { desc: 'deploy-bot cannot read secrets', args: ['auth', 'can-i', 'get', 'secrets', '-n', 'arch-rbac', '--as=system:serviceaccount:arch-rbac:deploy-bot'], expect: { eq: 'no', allowFail: true } },
      { desc: 'No access outside the namespace', args: ['auth', 'can-i', 'create', 'deployments', '-n', 'default', '--as=system:serviceaccount:arch-rbac:deploy-bot'], expect: { eq: 'no', allowFail: true } },
      { desc: 'RoleBinding deploy-bot-binding exists', args: ['get', 'rolebinding', 'deploy-bot-binding', '-n', 'arch-rbac', '-o', 'jsonpath={.roleRef.name}'], expect: { eq: 'deploy-manager' } },
    ],
    hints: ['All three objects can be created imperatively: `kubectl create sa|role|rolebinding`.', 'ServiceAccount subject syntax: `--serviceaccount=<namespace>:<name>`.', 'Impersonate with `--as=system:serviceaccount:<ns>:<name>`.'],
    solution: `kubectl -n arch-rbac create serviceaccount deploy-bot
kubectl -n arch-rbac create role deploy-manager --verb=create,get,list --resource=deployments
kubectl -n arch-rbac create rolebinding deploy-bot-binding \\
  --role=deploy-manager --serviceaccount=arch-rbac:deploy-bot
kubectl -n arch-rbac auth can-i create deployments --as=system:serviceaccount:arch-rbac:deploy-bot   # yes
kubectl -n arch-rbac auth can-i delete deployments --as=system:serviceaccount:arch-rbac:deploy-bot   # no`,
    cleanup: delNs('arch-rbac'),
    docs: `${DOCS}/reference/access-authn-authz/rbac/`,
  },
  {
    id: 'arch-rbac-cluster',
    domain: 'arch',
    title: 'RBAC: ClusterRole for a user',
    difficulty: 'Easy',
    minutes: 4,
    lab: true,
    scenario: `The user \`jane\` must be able to inspect storage cluster-wide.

- Create a ClusterRole \`lab-pv-viewer\` allowing \`get\`, \`list\` and \`watch\` on **PersistentVolumes** and **StorageClasses**.
- Bind it to user \`jane\` with a ClusterRoleBinding \`lab-pv-viewer-jane\`.`,
    checks: [
      { desc: 'jane can list persistentvolumes', args: ['auth', 'can-i', 'list', 'persistentvolumes', '--as=jane'], expect: { eq: 'yes' } },
      { desc: 'jane can get storageclasses', args: ['auth', 'can-i', 'get', 'storageclasses', '--as=jane'], expect: { eq: 'yes' } },
      { desc: 'jane cannot delete persistentvolumes', args: ['auth', 'can-i', 'delete', 'persistentvolumes', '--as=jane'], expect: { eq: 'no', allowFail: true } },
      { desc: 'jane cannot list pods', args: ['auth', 'can-i', 'list', 'pods', '-A', '--as=jane'], expect: { eq: 'no', allowFail: true } },
      { desc: 'ClusterRoleBinding lab-pv-viewer-jane exists', args: ['get', 'clusterrolebinding', 'lab-pv-viewer-jane', '-o', 'jsonpath={.roleRef.name}'], expect: { eq: 'lab-pv-viewer' } },
    ],
    hints: ['PersistentVolumes and StorageClasses are cluster-scoped, so a Role/RoleBinding cannot grant them.', 'StorageClass lives in the `storage.k8s.io` API group — `kubectl create clusterrole --resource=storageclasses` resolves the group for you.'],
    solution: `kubectl create clusterrole lab-pv-viewer --verb=get,list,watch --resource=persistentvolumes,storageclasses
kubectl create clusterrolebinding lab-pv-viewer-jane --clusterrole=lab-pv-viewer --user=jane
kubectl auth can-i list pv --as=jane
kubectl auth can-i --list --as=jane`,
    cleanup: [
      ['delete', 'clusterrolebinding', 'lab-pv-viewer-jane', '--ignore-not-found'],
      ['delete', 'clusterrole', 'lab-pv-viewer', '--ignore-not-found'],
    ],
    docs: `${DOCS}/reference/access-authn-authz/rbac/`,
  },
  {
    id: 'arch-crd',
    domain: 'arch',
    title: 'CRDs: explore and use a custom resource',
    difficulty: 'Medium',
    minutes: 6,
    lab: true,
    scenario: `An operator installed two CustomResourceDefinitions in the API group \`certmgr.lab.io\` (modelled on the cert-manager question many candidates report).

1. Save the names of all CRDs labelled \`app=certmgr\` to \`crd-list.txt\` (in the exam: "all CRDs containing cert-manager", via \`grep\`).
2. Save the documentation of the \`spec.subject\` field of the \`Certificate\` resource to \`cert-subject.txt\` using \`kubectl explain\`.
3. Create a \`Certificate\` named \`web-cert\` in namespace \`arch-crd\` with \`spec.dnsNames: ["web.lab.local"]\` and \`spec.issuerRef.name: lab-issuer\`.`,
    setup: {
      yaml:
        ns('arch-crd') +
        `---
apiVersion: apiextensions.k8s.io/v1
kind: CustomResourceDefinition
metadata:
  name: certificates.certmgr.lab.io
  labels:
    app: certmgr
spec:
  group: certmgr.lab.io
  scope: Namespaced
  names:
    plural: certificates
    singular: certificate
    kind: Certificate
    shortNames: ["labcert"]
  versions:
  - name: v1
    served: true
    storage: true
    schema:
      openAPIV3Schema:
        type: object
        properties:
          spec:
            type: object
            description: Desired state of the Certificate.
            required: ["dnsNames", "issuerRef"]
            properties:
              dnsNames:
                type: array
                description: DNS subject alternative names to request.
                items:
                  type: string
              issuerRef:
                type: object
                description: Reference to the Issuer that signs this certificate.
                required: ["name"]
                properties:
                  name:
                    type: string
              subject:
                type: object
                description: Full X509 name specification for the lab certificate.
                properties:
                  organizations:
                    type: array
                    description: Organizations to be used on the Certificate.
                    items:
                      type: string
                  countries:
                    type: array
                    description: Countries to be used on the Certificate.
                    items:
                      type: string
---
apiVersion: apiextensions.k8s.io/v1
kind: CustomResourceDefinition
metadata:
  name: issuers.certmgr.lab.io
  labels:
    app: certmgr
spec:
  group: certmgr.lab.io
  scope: Namespaced
  names:
    plural: issuers
    singular: issuer
    kind: Issuer
  versions:
  - name: v1
    served: true
    storage: true
    schema:
      openAPIV3Schema:
        type: object
        properties:
          spec:
            type: object
            x-kubernetes-preserve-unknown-fields: true
`,
    },
    checks: [
      { desc: 'crd-list.txt lists both CRDs', file: 'crd-list.txt', expect: { contains: ['certificates.certmgr.lab.io', 'issuers.certmgr.lab.io'] } },
      { desc: 'cert-subject.txt holds the explain output for spec.subject', file: 'cert-subject.txt', expect: { contains: ['Full X509 name specification', 'organizations'] } },
      { desc: 'Certificate web-cert has the dnsName', args: ['get', 'certificates.certmgr.lab.io', 'web-cert', '-n', 'arch-crd', '-o', 'jsonpath={.spec.dnsNames[0]}'], expect: { eq: 'web.lab.local' } },
      { desc: 'Certificate web-cert references lab-issuer', args: ['get', 'certificates.certmgr.lab.io', 'web-cert', '-n', 'arch-crd', '-o', 'jsonpath={.spec.issuerRef.name}'], expect: { eq: 'lab-issuer' } },
    ],
    hints: ['`kubectl get crd -l app=certmgr -o name > crd-list.txt`', '`kubectl explain certificates.certmgr.lab.io.spec.subject` — use the full `resource.group` form when a short name could be ambiguous.', 'For the custom resource: `apiVersion: certmgr.lab.io/v1`, `kind: Certificate`. `kubectl api-resources --api-group=certmgr.lab.io` confirms the kind.'],
    solution: `kubectl get crd -l app=certmgr -o name > crd-list.txt
#   exam: kubectl get crd | grep cert-manager > /opt/crds.txt
kubectl explain certificates.certmgr.lab.io.spec.subject > cert-subject.txt
#   exam: kubectl explain certificate.spec.subject > /opt/subject.txt

kubectl api-resources --api-group=certmgr.lab.io
kubectl apply -f - <<EOF
apiVersion: certmgr.lab.io/v1
kind: Certificate
metadata:
  name: web-cert
  namespace: arch-crd
spec:
  dnsNames: ["web.lab.local"]
  issuerRef:
    name: lab-issuer
EOF`,
    cleanup: [...delNs('arch-crd'), ['delete', 'crd', 'certificates.certmgr.lab.io', 'issuers.certmgr.lab.io', '--ignore-not-found']],
    cleanupFiles: ['crd-list.txt', 'cert-subject.txt'],
    docs: `${DOCS}/tasks/extend-kubernetes/custom-resources/custom-resource-definitions/`,
  },
  {
    id: 'arch-kustomize',
    domain: 'arch',
    title: 'Kustomize: build and deploy a production overlay',
    difficulty: 'Medium',
    minutes: 8,
    lab: true,
    scenario: `Setup placed a Kustomize base in the workspace at \`kustomize-lab/base\` (Deployment \`web\` + Service \`web\`).

Create \`kustomize-lab/overlays/prod/kustomization.yaml\` (use the YAML editor's "Save as") so that it:
- builds on the base,
- deploys into namespace \`arch-kustomize\`,
- prefixes every resource name with \`prod-\`,
- runs **3** replicas of the Deployment,
- uses the image tag \`1.27-alpine\` for \`nginx\`,
- adds the label \`env: prod\` to all resources.

Then deploy it with \`kubectl apply -k kustomize-lab/overlays/prod\`.`,
    setup: {
      yaml: ns('arch-kustomize'),
      files: {
        'kustomize-lab/base/kustomization.yaml': `apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
resources:
- deployment.yaml
- service.yaml
`,
        'kustomize-lab/base/deployment.yaml': `apiVersion: apps/v1
kind: Deployment
metadata:
  name: web
spec:
  replicas: 1
  selector:
    matchLabels:
      app: web
  template:
    metadata:
      labels:
        app: web
    spec:
      containers:
      - name: web
        image: nginx:1.25-alpine
        ports:
        - containerPort: 80
`,
        'kustomize-lab/base/service.yaml': `apiVersion: v1
kind: Service
metadata:
  name: web
spec:
  selector:
    app: web
  ports:
  - port: 80
    targetPort: 80
`,
      },
    },
    checks: [
      { desc: 'Deployment prod-web has 3 replicas', args: ['get', 'deploy', 'prod-web', '-n', 'arch-kustomize', '-o', 'jsonpath={.spec.replicas}'], expect: { eq: '3' } },
      { desc: 'Image is nginx:1.27-alpine', args: ['get', 'deploy', 'prod-web', '-n', 'arch-kustomize', '-o', 'jsonpath={.spec.template.spec.containers[0].image}'], expect: { eq: 'nginx:1.27-alpine' } },
      { desc: 'Deployment carries label env=prod', args: ['get', 'deploy', 'prod-web', '-n', 'arch-kustomize', '-o', 'jsonpath={.metadata.labels.env}'], expect: { eq: 'prod' } },
      { desc: 'Service prod-web exists with label env=prod', args: ['get', 'svc', 'prod-web', '-n', 'arch-kustomize', '-o', 'jsonpath={.metadata.labels.env}'], expect: { eq: 'prod' } },
      { desc: 'Base files were not modified', file: 'kustomize-lab/base/deployment.yaml', expect: { contains: ['replicas: 1', 'nginx:1.25-alpine'] } },
    ],
    hints: ['Preview without applying: `kubectl kustomize kustomize-lab/overlays/prod`.', 'Fields you need: `resources`, `namespace`, `namePrefix`, `replicas`, `images`, `labels`.', 'The base path is relative to the overlay directory: `../../base`.'],
    solution: `# kustomize-lab/overlays/prod/kustomization.yaml
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
resources:
- ../../base
namespace: arch-kustomize
namePrefix: prod-
labels:
- pairs:
    env: prod
replicas:
- name: web
  count: 3
images:
- name: nginx
  newTag: 1.27-alpine

# then
kubectl kustomize kustomize-lab/overlays/prod      # render only
kubectl apply -k kustomize-lab/overlays/prod
kubectl -n arch-kustomize get deploy,svc --show-labels`,
    cleanup: delNs('arch-kustomize'),
    cleanupFiles: ['kustomize-lab'],
    docs: `${DOCS}/tasks/manage-kubernetes-objects/kustomization/`,
  },
  {
    id: 'arch-helm',
    domain: 'arch',
    title: 'Helm: template and install Argo CD',
    difficulty: 'Medium',
    minutes: 8,
    lab: false,
    scenario: `One of the most frequently reported tasks:

- Add the official Argo CD Helm repository with the name \`argo\`.
- Generate a manifest (template only, do not install) for chart version \`7.7.3\` in namespace \`argocd\`, with CRD installation **disabled** because the CRDs already exist, and save it to \`~/argo-helm.yaml\`.
- Some variants then ask you to install the release \`argocd\` with the same settings.

**Practising locally:** with \`helm\` installed on this machine, \`helm\` commands work in the console. Scenario Q2 is the graded version of this task.`,
    hints: ['Find the right value name instead of guessing: `helm show values argo/argo-cd --version 7.7.3 | grep -i -A3 crds`.', '`helm template` renders locally; `--namespace` only sets metadata, it does not create the namespace.'],
    solution: `helm repo add argo https://argoproj.github.io/argo-helm
helm repo update
helm search repo argo/argo-cd --versions | head

helm show values argo/argo-cd --version 7.7.3 | grep -n -A3 '^crds'
helm template argocd argo/argo-cd --version 7.7.3 \\
  --namespace argocd --set crds.install=false > ~/argo-helm.yaml

# install variant
helm install argocd argo/argo-cd --version 7.7.3 \\
  --namespace argocd --create-namespace --set crds.install=false

# everyday helm
helm list -A
helm status argocd -n argocd
helm get values argocd -n argocd
helm upgrade argocd argo/argo-cd -n argocd --set server.replicas=2 --reuse-values
helm history argocd -n argocd
helm rollback argocd 1 -n argocd
helm uninstall argocd -n argocd`,
    docs: 'https://helm.sh/docs/helm/helm_template/',
  },
  {
    id: 'arch-upgrade',
    domain: 'arch',
    title: 'Upgrade a kubeadm cluster',
    difficulty: 'Hard',
    minutes: 12,
    lab: false,
    scenario: `Upgrade the control-plane node from Kubernetes \`1.34.x\` to \`1.35.1\`, including kubelet and kubectl, then upgrade the worker node. Drain nodes before upgrading the kubelet and make them schedulable again afterwards.

**Practising locally:** minikube nodes are not managed with apt, so this cannot be run here. Use a kubeadm VM lab or Killercoda — do it at least twice from memory; the docs page "Upgrading kubeadm clusters" has every command.`,
    hints: ['Order: kubeadm first → `kubeadm upgrade apply` → drain → kubelet/kubectl → restart kubelet → uncordon.', 'Workers use `kubeadm upgrade node`, not `upgrade apply`.', 'If apt cannot find the new version, the repo in `/etc/apt/sources.list.d/kubernetes.list` still points at the old minor (v1.34).'],
    solution: `# ── control plane ──
ssh controlplane && sudo -i
# switch the package repo to the new minor if needed
sed -i 's/v1.34/v1.35/' /etc/apt/sources.list.d/kubernetes.list && apt-get update
apt-cache madison kubeadm | head

apt-mark unhold kubeadm && apt-get install -y kubeadm='1.35.1-*' && apt-mark hold kubeadm
kubeadm version
kubeadm upgrade plan
kubeadm upgrade apply v1.35.1

kubectl drain controlplane --ignore-daemonsets
apt-mark unhold kubelet kubectl && apt-get install -y kubelet='1.35.1-*' kubectl='1.35.1-*' && apt-mark hold kubelet kubectl
systemctl daemon-reload && systemctl restart kubelet
kubectl uncordon controlplane

# ── worker ──
kubectl drain node01 --ignore-daemonsets --delete-emptydir-data     # run from the control plane
ssh node01 && sudo -i
apt-mark unhold kubeadm && apt-get update && apt-get install -y kubeadm='1.35.1-*' && apt-mark hold kubeadm
kubeadm upgrade node
apt-mark unhold kubelet kubectl && apt-get install -y kubelet='1.35.1-*' kubectl='1.35.1-*' && apt-mark hold kubelet kubectl
systemctl daemon-reload && systemctl restart kubelet
exit
kubectl uncordon node01
kubectl get nodes`,
    docs: `${DOCS}/tasks/administer-cluster/kubeadm/kubeadm-upgrade/`,
  },
  {
    id: 'arch-etcd',
    domain: 'arch',
    title: 'Back up and restore etcd',
    difficulty: 'Hard',
    minutes: 10,
    lab: false,
    scenario: `Create a snapshot of the etcd database at \`/opt/etcd-backup.db\`, then restore the cluster from that snapshot into a new data directory \`/var/lib/etcd-restore\`.

No longer a named curriculum line, but it falls under "manage the lifecycle of Kubernetes clusters" and candidates still report it.

**Practising locally:** \`minikube ssh -p ${PROFILE}\`, then \`sudo cat /etc/kubernetes/manifests/etcd.yaml\`. On minikube the certificates live under \`/var/lib/minikube/certs/etcd/\` instead of \`/etc/kubernetes/pki/etcd/\`. Finding the right paths in the manifest is exactly the exam skill.`,
    hints: ['All four connection flags can be read from the etcd static Pod manifest: `--listen-client-urls`, `--trusted-ca-file`, `--cert-file`, `--key-file`.', 'Restore never touches the running etcd: it writes a new data dir, and you point the static Pod\'s hostPath volume at it.'],
    solution: `ssh controlplane && sudo -i
grep -E 'listen-client-urls|trusted-ca-file|cert-file|key-file|data-dir' /etc/kubernetes/manifests/etcd.yaml

# backup
ETCDCTL_API=3 etcdctl --endpoints=https://127.0.0.1:2379 \\
  --cacert=/etc/kubernetes/pki/etcd/ca.crt \\
  --cert=/etc/kubernetes/pki/etcd/server.crt \\
  --key=/etc/kubernetes/pki/etcd/server.key \\
  snapshot save /opt/etcd-backup.db
etcdutl snapshot status /opt/etcd-backup.db -w table

# restore (etcdutl; older releases: etcdctl snapshot restore)
etcdutl snapshot restore /opt/etcd-backup.db --data-dir /var/lib/etcd-restore

# point etcd at the restored data
vi /etc/kubernetes/manifests/etcd.yaml
#   volumes:
#   - hostPath:
#       path: /var/lib/etcd-restore      # was /var/lib/etcd
#     name: etcd-data
# kubelet recreates etcd; the API server follows after a minute
watch crictl ps
kubectl get nodes`,
    docs: `${DOCS}/tasks/administer-cluster/configure-upgrade-etcd/`,
  },
  {
    id: 'arch-cri',
    domain: 'arch',
    title: 'Prepare a node: cri-dockerd and kernel parameters',
    difficulty: 'Medium',
    minutes: 6,
    lab: false,
    scenario: `Prepare a Linux host for kubeadm (frequently reported):

- Install the Debian package \`~/cri-dockerd_0.3.x.deb\`.
- Enable and start the \`cri-docker\` service.
- Configure these kernel parameters so they persist across reboots:
  - \`net.bridge.bridge-nf-call-iptables = 1\`
  - \`net.ipv6.conf.all.forwarding = 1\`
  - \`net.ipv4.ip_forward = 1\`
  - \`net.netfilter.nf_conntrack_max = 131072\`

**Practising locally:** the sysctl part can be tried on any Linux VM. Don't change sysctls on your minikube host for practice.`,
    hints: ['Persistent = a file under `/etc/sysctl.d/`, applied with `sysctl --system`. `sysctl -w` alone is lost on reboot.', '`net.bridge.*` keys only exist once the `br_netfilter` module is loaded.'],
    solution: `sudo dpkg -i ~/cri-dockerd_0.3.x.deb
sudo systemctl enable --now cri-docker.service
sudo systemctl enable --now cri-docker.socket
systemctl is-active cri-docker

# kernel modules (needed for the bridge sysctls)
cat <<EOF | sudo tee /etc/modules-load.d/k8s.conf
overlay
br_netfilter
EOF
sudo modprobe overlay && sudo modprobe br_netfilter

cat <<EOF | sudo tee /etc/sysctl.d/k8s.conf
net.bridge.bridge-nf-call-iptables = 1
net.ipv6.conf.all.forwarding = 1
net.ipv4.ip_forward = 1
net.netfilter.nf_conntrack_max = 131072
EOF
sudo sysctl --system
sysctl net.ipv4.ip_forward net.bridge.bridge-nf-call-iptables

# kubeadm with this runtime:
#   kubeadm init --cri-socket unix:///var/run/cri-dockerd.sock`,
    docs: `${DOCS}/setup/production-environment/container-runtimes/`,
  },
  {
    id: 'arch-cni',
    domain: 'arch',
    title: 'Install a CNI plugin',
    difficulty: 'Medium',
    minutes: 8,
    lab: false,
    scenario: `A freshly initialised cluster has no CNI: all nodes are \`NotReady\` and CoreDNS is \`Pending\`.

Install a CNI that lets Pods communicate across nodes **and enforces NetworkPolicy**. You are offered two manifests: Flannel and Calico (Tigera operator).

**Practising locally:** create a second profile so your main cluster is untouched: \`minikube start -p cni-lab --cni=false --network-plugin=cni\`, then install Calico into it.`,
    hints: ['Flannel does not implement NetworkPolicy; Calico does. The requirement decides the choice.', 'Use `kubectl create -f` for the Tigera operator: its CRDs are too large for the annotation that `kubectl apply` adds.', 'The Calico pod CIDR must match the cluster\'s `--pod-network-cidr`.'],
    solution: `kubectl get nodes                               # NotReady
kubectl describe node | grep -i 'network plugin'  # cni plugin not initialized

# which pod CIDR does the cluster use?
kubectl -n kube-system get cm kubeadm-config -o yaml | grep podSubnet
kubectl cluster-info dump | grep -m1 cluster-cidr

# Calico via Tigera operator (URL is given in the task)
kubectl create -f https://raw.githubusercontent.com/projectcalico/calico/v3.29.2/manifests/tigera-operator.yaml
curl -LO https://raw.githubusercontent.com/projectcalico/calico/v3.29.2/manifests/custom-resources.yaml
vi custom-resources.yaml          # spec.calicoNetwork.ipPools[0].cidr: <podSubnet>
kubectl create -f custom-resources.yaml

kubectl get pods -n calico-system -w
kubectl get nodes                               # Ready

# extension interfaces to know:
#   CNI  /etc/cni/net.d/  /opt/cni/bin/   pod networking
#   CRI  containerd / cri-o / cri-dockerd  (crictl, --container-runtime-endpoint)
#   CSI  storage drivers  (kubectl get csidrivers,csinodes)`,
    docs: `${DOCS}/concepts/cluster-administration/addons/`,
  },
  {
    id: 'arch-kubeadm',
    domain: 'arch',
    title: 'kubeadm: join a node and plan an HA control plane',
    difficulty: 'Medium',
    minutes: 8,
    lab: false,
    scenario: `1. A prepared host \`node02\` (container runtime, kubeadm and kubelet installed) must join the existing cluster as a worker.
2. Know how you would initialise a **highly available** control plane behind a load balancer and add a second control-plane node.

**Practising locally:** \`minikube node add -p ${PROFILE}\` uses kubeadm join under the hood, but to type the commands yourself use a kubeadm VM lab or Killercoda.`,
    hints: ['Never hunt for old tokens: `kubeadm token create --print-join-command` prints a complete, fresh join command.', 'HA needs a stable `--control-plane-endpoint` (load balancer DNS/IP) at init time; it cannot be added easily later.'],
    solution: `# ── join a worker ──
# on the control plane
kubeadm token create --print-join-command
# on node02
sudo kubeadm join <cp-endpoint>:6443 --token <token> \\
  --discovery-token-ca-cert-hash sha256:<hash>
# back on the control plane
kubectl get nodes

# ── new cluster ──
sudo kubeadm init --pod-network-cidr=10.244.0.0/16
mkdir -p $HOME/.kube && sudo cp /etc/kubernetes/admin.conf $HOME/.kube/config && sudo chown $(id -u):$(id -g) $HOME/.kube/config
# ...then install a CNI

# ── HA control plane (stacked etcd) ──
sudo kubeadm init --control-plane-endpoint "lb.example.com:6443" --upload-certs \\
  --pod-network-cidr=10.244.0.0/16
# additional control-plane node:
sudo kubeadm join lb.example.com:6443 --token <token> \\
  --discovery-token-ca-cert-hash sha256:<hash> \\
  --control-plane --certificate-key <key>
# certificate key expired (2h)?  ->  kubeadm init phase upload-certs --upload-certs

# certificates
kubeadm certs check-expiration
kubeadm certs renew all`,
    docs: `${DOCS}/setup/production-environment/tools/kubeadm/create-cluster-kubeadm/`,
  },

  // ───────────────────────── Services & Networking (20%) ─────────────────────────
  {
    id: 'net-nodeport',
    domain: 'net',
    title: 'Expose a Deployment with a NodePort Service',
    difficulty: 'Easy',
    minutes: 5,
    lab: true,
    scenario: `In namespace \`net-nodeport\` the Deployment \`front-end\` runs nginx but declares no ports.

- Add a container port named \`http\` (\`80/TCP\`) to the existing Deployment.
- Create a Service \`front-end-svc\` of type **NodePort** that exposes port \`80\`, targets the port **by its name** \`http\`, and uses node port \`30080\`.`,
    setup: { yaml: ns('net-nodeport') + deploy({ name: 'front-end', namespace: 'net-nodeport', replicas: 2 }) },
    checks: [
      { desc: 'Container port named http = 80', args: ['get', 'deploy', 'front-end', '-n', 'net-nodeport', '-o', 'jsonpath={.spec.template.spec.containers[0].ports[?(@.name=="http")].containerPort}'], expect: { eq: '80' } },
      { desc: 'Service type is NodePort', args: ['get', 'svc', 'front-end-svc', '-n', 'net-nodeport', '-o', 'jsonpath={.spec.type}'], expect: { eq: 'NodePort' } },
      { desc: 'Service targets the named port http', args: ['get', 'svc', 'front-end-svc', '-n', 'net-nodeport', '-o', 'jsonpath={.spec.ports[0].targetPort}'], expect: { eq: 'http' } },
      { desc: 'nodePort is 30080', args: ['get', 'svc', 'front-end-svc', '-n', 'net-nodeport', '-o', 'jsonpath={.spec.ports[0].nodePort}'], expect: { eq: '30080' } },
      { desc: 'Service has endpoints', args: ['get', 'endpointslices', '-n', 'net-nodeport', '-l', 'kubernetes.io/service-name=front-end-svc', '-o', 'jsonpath={.items[*].endpoints[*].addresses[*]}'], expect: { nonEmpty: true } },
    ],
    hints: ['`kubectl expose` cannot set a fixed nodePort — generate YAML with `--dry-run=client -o yaml` and add it, or write the Service by hand.', 'Patch the port in: `kubectl patch deploy front-end --type json -p \'[{"op":"add","path":"/spec/template/spec/containers/0/ports","value":[{"name":"http","containerPort":80}]}]\'`'],
    solution: `kubectl -n net-nodeport patch deploy front-end --type json \\
  -p '[{"op":"add","path":"/spec/template/spec/containers/0/ports","value":[{"name":"http","containerPort":80,"protocol":"TCP"}]}]'

kubectl apply -f - <<EOF
apiVersion: v1
kind: Service
metadata:
  name: front-end-svc
  namespace: net-nodeport
spec:
  type: NodePort
  selector:
    app: front-end
  ports:
  - port: 80
    targetPort: http
    nodePort: 30080
EOF
kubectl -n net-nodeport get svc,endpointslices`,
    cleanup: delNs('net-nodeport'),
    docs: `${DOCS}/concepts/services-networking/service/`,
  },
  {
    id: 'net-netpol',
    domain: 'net',
    title: 'NetworkPolicy: allow only the frontend',
    difficulty: 'Medium',
    minutes: 8,
    lab: true,
    scenario: `Pods \`app=backend\` run in namespace \`net-backend\`; Pods \`app=frontend\` run in namespace \`net-frontend\`.

Create a NetworkPolicy \`allow-frontend\` in \`net-backend\` that applies to the backend Pods and allows ingress **only** from Pods labelled \`app=frontend\` in namespace \`net-frontend\`, and only on **TCP port 80**. Be as restrictive as possible — nothing else may be allowed.

(The exam variant gives you several policy files and asks you to apply the least permissive one that works — the same reasoning.)

Note: minikube's default CNI does not *enforce* NetworkPolicy; the checks validate your spec.`,
    setup: {
      yaml:
        ns('net-backend') +
        '---\n' +
        ns('net-frontend') +
        deploy({ name: 'backend', namespace: 'net-backend' }) +
        deploy({ name: 'frontend', namespace: 'net-frontend', image: BUSYBOX, extra: '\n        command: ["sh", "-c", "sleep 1d"]' }),
    },
    checks: [
      { desc: 'Policy selects app=backend pods', args: ['get', 'netpol', 'allow-frontend', '-n', 'net-backend', '-o', 'jsonpath={.spec.podSelector.matchLabels.app}'], expect: { eq: 'backend' } },
      { desc: 'Policy type includes Ingress', args: ['get', 'netpol', 'allow-frontend', '-n', 'net-backend', '-o', 'jsonpath={.spec.policyTypes[*]}'], expect: { match: 'Ingress' } },
      { desc: 'Exactly one ingress rule with one source', args: ['get', 'netpol', 'allow-frontend', '-n', 'net-backend', '-o', 'jsonpath={range .spec.ingress[*]}R{range .from[*]}F{end}{end}'], expect: { eq: 'RF' } },
      { desc: 'Source restricts the namespace to net-frontend', args: ['get', 'netpol', 'allow-frontend', '-n', 'net-backend', '-o', 'jsonpath={.spec.ingress[0].from[0].namespaceSelector.matchLabels.kubernetes\\.io/metadata\\.name}'], expect: { eq: 'net-frontend' } },
      { desc: 'Same source also restricts pods to app=frontend (AND)', args: ['get', 'netpol', 'allow-frontend', '-n', 'net-backend', '-o', 'jsonpath={.spec.ingress[0].from[0].podSelector.matchLabels.app}'], expect: { eq: 'frontend' } },
      { desc: 'Only TCP 80 is allowed', args: ['get', 'netpol', 'allow-frontend', '-n', 'net-backend', '-o', 'jsonpath={range .spec.ingress[0].ports[*]}{.protocol}/{.port} {end}'], expect: { match: '^(TCP)?/80$' } },
    ],
    hints: ['Every namespace carries the automatic label `kubernetes.io/metadata.name=<name>` — use it in `namespaceSelector`.', '`namespaceSelector` and `podSelector` in the **same** list item are ANDed. As two separate items (two dashes) they are ORed — far more permissive.', 'There is no imperative command for NetworkPolicies; copy the example from the docs page and trim it.'],
    solution: `kubectl get ns net-frontend --show-labels
kubectl apply -f - <<EOF
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: allow-frontend
  namespace: net-backend
spec:
  podSelector:
    matchLabels:
      app: backend
  policyTypes:
  - Ingress
  ingress:
  - from:
    - namespaceSelector:            # one list item = namespace AND pod
        matchLabels:
          kubernetes.io/metadata.name: net-frontend
      podSelector:
        matchLabels:
          app: frontend
    ports:
    - protocol: TCP
      port: 80
EOF
kubectl -n net-backend describe netpol allow-frontend`,
    cleanup: delNs('net-backend', 'net-frontend'),
    docs: `${DOCS}/concepts/services-networking/network-policies/`,
  },
  {
    id: 'net-deny',
    domain: 'net',
    title: 'NetworkPolicy: default deny with DNS egress',
    difficulty: 'Medium',
    minutes: 6,
    lab: true,
    scenario: `Lock down namespace \`net-deny\`:

- Create a NetworkPolicy \`default-deny\` that selects **all** Pods in the namespace and denies all ingress **and** egress traffic.
- Create a second NetworkPolicy \`allow-dns\` that selects all Pods and allows egress on port \`53\` over both **UDP** and **TCP** (to any destination), so name resolution keeps working.`,
    setup: { yaml: ns('net-deny') + deploy({ name: 'app', namespace: 'net-deny' }) },
    checks: [
      { desc: 'default-deny selects all pods', args: ['get', 'netpol', 'default-deny', '-n', 'net-deny', '-o', 'jsonpath={.spec.podSelector}'], expect: { eq: '{}' } },
      { desc: 'default-deny covers Ingress and Egress', args: ['get', 'netpol', 'default-deny', '-n', 'net-deny', '-o', 'jsonpath={.spec.policyTypes[*]}'], expect: { match: '^(Ingress Egress|Egress Ingress)$' } },
      { desc: 'default-deny has no allow rules', args: ['get', 'netpol', 'default-deny', '-n', 'net-deny', '-o', 'jsonpath={.spec.ingress}{.spec.egress}'], expect: { eq: '' } },
      { desc: 'allow-dns is an Egress policy for all pods', args: ['get', 'netpol', 'allow-dns', '-n', 'net-deny', '-o', 'jsonpath={.spec.podSelector}|{.spec.policyTypes[*]}'], expect: { eq: '{}|Egress' } },
      { desc: 'allow-dns allows UDP/53 and TCP/53', args: ['get', 'netpol', 'allow-dns', '-n', 'net-deny', '-o', 'jsonpath={range .spec.egress[*].ports[*]}{.protocol}/{.port} {end}'], expect: { match: '^(UDP/53 TCP/53|TCP/53 UDP/53)$' } },
    ],
    hints: ['An empty `podSelector: {}` selects every Pod in the namespace.', 'A policy that lists a type in `policyTypes` but has no rules for it denies all traffic of that type.', 'Policies are additive: the union of all matching policies is what is allowed.'],
    solution: `kubectl apply -f - <<EOF
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: default-deny
  namespace: net-deny
spec:
  podSelector: {}
  policyTypes:
  - Ingress
  - Egress
---
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: allow-dns
  namespace: net-deny
spec:
  podSelector: {}
  policyTypes:
  - Egress
  egress:
  - ports:
    - protocol: UDP
      port: 53
    - protocol: TCP
      port: 53
EOF`,
    cleanup: delNs('net-deny'),
    docs: `${DOCS}/concepts/services-networking/network-policies/#default-policies`,
  },
  {
    id: 'net-ingress',
    domain: 'net',
    title: 'Ingress with path-based routing',
    difficulty: 'Medium',
    minutes: 7,
    lab: true,
    scenario: `Namespace \`net-ingress\` contains the Services \`api-svc\` (port \`8080\`) and \`web-svc\` (port \`80\`).

Create an Ingress \`shop\` in that namespace:
- ingress class \`nginx\`
- host \`shop.example.com\`
- path \`/api\` (type \`Prefix\`) → \`api-svc:8080\`
- path \`/\` (type \`Prefix\`) → \`web-svc:80\`
- annotation \`nginx.ingress.kubernetes.io/rewrite-target: /\`

Note: no ingress controller is required for the checks. To see it route for real, run \`minikube addons enable ingress -p ${PROFILE}\`.`,
    setup: {
      yaml:
        ns('net-ingress') +
        deploy({ name: 'api', namespace: 'net-ingress' }) +
        deploy({ name: 'web', namespace: 'net-ingress' }) +
        `---
apiVersion: v1
kind: Service
metadata:
  name: api-svc
  namespace: net-ingress
spec:
  selector:
    app: api
  ports:
  - port: 8080
    targetPort: 80
---
apiVersion: v1
kind: Service
metadata:
  name: web-svc
  namespace: net-ingress
spec:
  selector:
    app: web
  ports:
  - port: 80
    targetPort: 80
`,
    },
    checks: [
      { desc: 'ingressClassName is nginx', args: ['get', 'ingress', 'shop', '-n', 'net-ingress', '-o', 'jsonpath={.spec.ingressClassName}'], expect: { eq: 'nginx' } },
      { desc: 'Host is shop.example.com', args: ['get', 'ingress', 'shop', '-n', 'net-ingress', '-o', 'jsonpath={.spec.rules[0].host}'], expect: { eq: 'shop.example.com' } },
      { desc: '/api (Prefix) → api-svc:8080', args: ['get', 'ingress', 'shop', '-n', 'net-ingress', '-o', 'jsonpath={range .spec.rules[0].http.paths[?(@.path=="/api")]}{.pathType}:{.backend.service.name}:{.backend.service.port.number}{end}'], expect: { eq: 'Prefix:api-svc:8080' } },
      { desc: '/ (Prefix) → web-svc:80', args: ['get', 'ingress', 'shop', '-n', 'net-ingress', '-o', 'jsonpath={range .spec.rules[0].http.paths[?(@.path=="/")]}{.pathType}:{.backend.service.name}:{.backend.service.port.number}{end}'], expect: { eq: 'Prefix:web-svc:80' } },
      { desc: 'rewrite-target annotation set', args: ['get', 'ingress', 'shop', '-n', 'net-ingress', '-o', 'jsonpath={.metadata.annotations.nginx\\.ingress\\.kubernetes\\.io/rewrite-target}'], expect: { eq: '/' } },
    ],
    hints: ['Imperative: `kubectl create ingress shop --class=nginx --rule="host/path*=svc:port"` — a trailing `*` makes the path type Prefix.', 'Add the annotation with `--annotation` or `kubectl annotate`.'],
    solution: `kubectl -n net-ingress create ingress shop --class=nginx \\
  --rule="shop.example.com/api*=api-svc:8080" \\
  --rule="shop.example.com/*=web-svc:80" \\
  --annotation nginx.ingress.kubernetes.io/rewrite-target=/
kubectl -n net-ingress describe ingress shop
kubectl get ingressclass
# with a controller: curl -H 'Host: shop.example.com' http://$(minikube ip -p ${PROFILE})/api`,
    cleanup: delNs('net-ingress'),
    docs: `${DOCS}/concepts/services-networking/ingress/`,
  },
  {
    id: 'net-gateway',
    domain: 'net',
    title: 'Migrate an Ingress to the Gateway API',
    difficulty: 'Hard',
    minutes: 10,
    lab: true,
    scenario: `Namespace \`net-gateway\` contains an Ingress \`web\` that terminates TLS for host \`gateway.web.k8s.local\` with Secret \`web-tls\` and routes \`/\` to Service \`web:80\`. A GatewayClass \`nginx\` is installed.

Migrate it to the Gateway API, keeping the same behaviour:
- Create a Gateway \`web-gateway\` using GatewayClass \`nginx\`, with one listener: \`HTTPS\`, port \`443\`, hostname \`gateway.web.k8s.local\`, TLS mode \`Terminate\` with the existing Secret \`web-tls\`.
- Create an HTTPRoute \`web-route\` attached to that Gateway for the same hostname, sending path prefix \`/\` to \`web:80\`.
- Finally delete the Ingress \`web\`.

**Setup installs the Gateway API CRDs (standard channel) cluster-wide** from the kubernetes-sigs release; they stay installed after cleanup. No gateway controller runs, so the Gateway will not get an address — the checks validate your spec.`,
    setup: {
      pre: [
        ['apply', '-f', 'https://github.com/kubernetes-sigs/gateway-api/releases/download/v1.2.1/standard-install.yaml'],
        ['wait', '--for=condition=Established', 'crd/gateways.gateway.networking.k8s.io', 'crd/httproutes.gateway.networking.k8s.io', 'crd/gatewayclasses.gateway.networking.k8s.io', '--timeout=60s'],
      ],
      yaml:
        ns('net-gateway') +
        deploy({ name: 'web', namespace: 'net-gateway' }) +
        `---
apiVersion: v1
kind: Service
metadata:
  name: web
  namespace: net-gateway
spec:
  selector:
    app: web
  ports:
  - port: 80
    targetPort: 80
---
apiVersion: v1
kind: Secret
metadata:
  name: web-tls
  namespace: net-gateway
type: kubernetes.io/tls
stringData:
  tls.crt: placeholder-certificate-for-practice
  tls.key: placeholder-key-for-practice
---
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: web
  namespace: net-gateway
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
            name: web
            port:
              number: 80
---
apiVersion: gateway.networking.k8s.io/v1
kind: GatewayClass
metadata:
  name: nginx
spec:
  controllerName: gateway.nginx.org/nginx-gateway-controller
`,
    },
    checks: [
      { desc: 'Gateway uses GatewayClass nginx', args: ['get', 'gateways.gateway.networking.k8s.io', 'web-gateway', '-n', 'net-gateway', '-o', 'jsonpath={.spec.gatewayClassName}'], expect: { eq: 'nginx' } },
      { desc: 'Listener is HTTPS on 443 for the hostname', args: ['get', 'gateways.gateway.networking.k8s.io', 'web-gateway', '-n', 'net-gateway', '-o', 'jsonpath={.spec.listeners[0].protocol}:{.spec.listeners[0].port}:{.spec.listeners[0].hostname}'], expect: { eq: 'HTTPS:443:gateway.web.k8s.local' } },
      { desc: 'TLS terminates with Secret web-tls', args: ['get', 'gateways.gateway.networking.k8s.io', 'web-gateway', '-n', 'net-gateway', '-o', 'jsonpath={.spec.listeners[0].tls.mode}:{.spec.listeners[0].tls.certificateRefs[0].name}'], expect: { match: '^(Terminate)?:web-tls$' } },
      { desc: 'HTTPRoute is attached to web-gateway', args: ['get', 'httproutes.gateway.networking.k8s.io', 'web-route', '-n', 'net-gateway', '-o', 'jsonpath={.spec.parentRefs[0].name}'], expect: { eq: 'web-gateway' } },
      { desc: 'HTTPRoute hostname matches', args: ['get', 'httproutes.gateway.networking.k8s.io', 'web-route', '-n', 'net-gateway', '-o', 'jsonpath={.spec.hostnames[0]}'], expect: { eq: 'gateway.web.k8s.local' } },
      { desc: 'Route sends / to web:80', args: ['get', 'httproutes.gateway.networking.k8s.io', 'web-route', '-n', 'net-gateway', '-o', 'jsonpath={.spec.rules[0].matches[0].path.value}:{.spec.rules[0].backendRefs[0].name}:{.spec.rules[0].backendRefs[0].port}'], expect: { eq: '/:web:80' } },
      { desc: 'Old Ingress web is deleted', args: ['get', 'ingress', '-n', 'net-gateway', '-o', 'name'], expect: { eq: '' } },
    ],
    hints: ['Read the Ingress first (`kubectl get ingress web -o yaml`): host, TLS secret, path and backend all map 1:1.', 'Ingress `tls` → Gateway `listeners[].tls.certificateRefs`; Ingress `rules` → HTTPRoute `hostnames` + `rules`.', 'The docs page "Gateway API" → HTTPRoute has copy-paste examples. `kubectl explain gateway.spec.listeners.tls` works too.'],
    solution: `kubectl -n net-gateway get ingress web -o yaml
kubectl get gatewayclass

kubectl apply -f - <<EOF
apiVersion: gateway.networking.k8s.io/v1
kind: Gateway
metadata:
  name: web-gateway
  namespace: net-gateway
spec:
  gatewayClassName: nginx
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
  namespace: net-gateway
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
    - name: web
      port: 80
EOF
kubectl -n net-gateway get gateway,httproute
kubectl -n net-gateway delete ingress web`,
    cleanup: [...delNs('net-gateway'), ['delete', 'gatewayclasses.gateway.networking.k8s.io', 'nginx', '--ignore-not-found']],
    docs: `${DOCS}/concepts/services-networking/gateway/`,
  },
  {
    id: 'net-dns',
    domain: 'net',
    title: 'Resolve a Service through CoreDNS',
    difficulty: 'Easy',
    minutes: 5,
    lab: true,
    scenario: `Namespace \`net-dns\` has a Service \`db-svc\`.

- From a temporary Pod (image \`${BUSYBOX}\`) in the \`default\` namespace, resolve the Service by its **fully qualified** cluster DNS name and save the output to \`dns.txt\`.
- Find the ConfigMap that holds the CoreDNS configuration and save it as YAML to \`coredns.yaml\`.`,
    setup: {
      yaml:
        ns('net-dns') +
        deploy({ name: 'db', namespace: 'net-dns' }) +
        `---
apiVersion: v1
kind: Service
metadata:
  name: db-svc
  namespace: net-dns
spec:
  selector:
    app: db
  ports:
  - port: 80
`,
    },
    checks: [
      { desc: 'dns.txt shows the FQDN being resolved', file: 'dns.txt', expect: { contains: ['db-svc.net-dns.svc.cluster.local', 'Address'] } },
      { desc: 'coredns.yaml contains the Corefile', file: 'coredns.yaml', expect: { contains: ['Corefile', 'kubernetes cluster.local'] } },
    ],
    hints: ['Service FQDN: `<service>.<namespace>.svc.cluster.local`.', 'Non-interactive one-shot Pod: `kubectl run tmp --rm -i --restart=Never --image=busybox:1.36 -- nslookup <name>`.', 'CoreDNS config lives in ConfigMap `coredns` in `kube-system`.'],
    solution: `kubectl run tmp --rm -i --restart=Never --image=busybox:1.36 -- \\
  nslookup db-svc.net-dns.svc.cluster.local > dns.txt
kubectl -n kube-system get configmap coredns -o yaml > coredns.yaml

# good to know
#   pod DNS:  <pod-ip-with-dashes>.<ns>.pod.cluster.local
#   kubectl -n kube-system get svc kube-dns        (the resolver IP in every pod's /etc/resolv.conf)
#   custom forwarding / stub domains: edit the Corefile, then
#   kubectl -n kube-system rollout restart deploy coredns`,
    cleanup: delNs('net-dns'),
    cleanupFiles: ['dns.txt', 'coredns.yaml'],
    docs: `${DOCS}/concepts/services-networking/dns-pod-service/`,
  },

  // ───────────────────────── Workloads & Scheduling (15%) ─────────────────────────
  {
    id: 'work-rollout',
    domain: 'work',
    title: 'Rolling update, rollback and scale',
    difficulty: 'Easy',
    minutes: 5,
    lab: true,
    scenario: `Deployment \`web\` in namespace \`work-rollout\` runs \`nginx:1.25-alpine\`.

1. Update the image to \`nginx:1.27-alpine\` and wait for the rollout.
2. The new version is "faulty": roll the Deployment **back** to the previous revision.
3. Scale the Deployment to **4** replicas.`,
    setup: { yaml: ns('work-rollout') + deploy({ name: 'web', namespace: 'work-rollout', replicas: 2, image: 'nginx:1.25-alpine' }) },
    checks: [
      { desc: 'Image is back to nginx:1.25-alpine', args: ['get', 'deploy', 'web', '-n', 'work-rollout', '-o', 'jsonpath={.spec.template.spec.containers[0].image}'], expect: { eq: 'nginx:1.25-alpine' } },
      { desc: 'Deployment went through update + rollback (revision ≥ 3)', args: ['get', 'deploy', 'web', '-n', 'work-rollout', '-o', 'jsonpath={.metadata.annotations.deployment\\.kubernetes\\.io/revision}'], expect: { gte: 3 } },
      { desc: '4 replicas ready', args: ['get', 'deploy', 'web', '-n', 'work-rollout', '-o', 'jsonpath={.status.readyReplicas}'], expect: { eq: '4' } },
    ],
    hints: ['`kubectl set image deploy/web <container>=<image>`', '`kubectl rollout history|status|undo deploy/web`'],
    solution: `kubectl -n work-rollout set image deploy/web web=nginx:1.27-alpine
kubectl -n work-rollout rollout status deploy/web
kubectl -n work-rollout rollout history deploy/web
kubectl -n work-rollout rollout undo deploy/web            # or --to-revision=1
kubectl -n work-rollout scale deploy/web --replicas=4
kubectl -n work-rollout get deploy web -o wide`,
    cleanup: delNs('work-rollout'),
    docs: `${DOCS}/concepts/workloads/controllers/deployment/`,
  },
  {
    id: 'work-config',
    domain: 'work',
    title: 'Configure a Pod with a ConfigMap and a Secret',
    difficulty: 'Easy',
    minutes: 6,
    lab: true,
    scenario: `In namespace \`work-config\`:

- Create a ConfigMap \`app-config\` with the key \`APP_MODE=production\`.
- Create a Secret \`app-secret\` with the key \`API_KEY=s3cr3t\`.
- Create a Pod \`app\` (image \`${BUSYBOX}\`, command \`sleep 1d\`) that
  - gets the environment variable \`API_KEY\` from the Secret, and
  - mounts the ConfigMap as a volume at \`/etc/app\`.`,
    setup: { yaml: ns('work-config') },
    checks: [
      { desc: 'Pod app is Running', args: ['get', 'pod', 'app', '-n', 'work-config', '-o', 'jsonpath={.status.phase}'], expect: { eq: 'Running' } },
      { desc: 'API_KEY env var arrives in the container', args: ['exec', 'app', '-n', 'work-config', '--', 'sh', '-c', 'echo $API_KEY'], expect: { eq: 's3cr3t' } },
      { desc: 'API_KEY comes from the Secret (not hard-coded)', args: ['get', 'pod', 'app', '-n', 'work-config', '-o', 'jsonpath={.spec.containers[0].env[?(@.name=="API_KEY")].valueFrom.secretKeyRef.name}{.spec.containers[0].envFrom[*].secretRef.name}'], expect: { eq: 'app-secret' } },
      { desc: 'ConfigMap mounted at /etc/app', args: ['exec', 'app', '-n', 'work-config', '--', 'cat', '/etc/app/APP_MODE'], expect: { eq: 'production' } },
    ],
    hints: ['`kubectl create configmap ... --from-literal`, `kubectl create secret generic ... --from-literal`.', 'Generate the Pod skeleton: `kubectl run app --image=busybox:1.36 --dry-run=client -o yaml -- sleep 1d`, load it into the editor and add `env` + `volumes`.'],
    solution: `kubectl -n work-config create configmap app-config --from-literal=APP_MODE=production
kubectl -n work-config create secret generic app-secret --from-literal=API_KEY=s3cr3t

kubectl apply -f - <<EOF
apiVersion: v1
kind: Pod
metadata:
  name: app
  namespace: work-config
spec:
  containers:
  - name: app
    image: busybox:1.36
    command: ["sleep", "1d"]
    env:
    - name: API_KEY
      valueFrom:
        secretKeyRef:
          name: app-secret
          key: API_KEY
    volumeMounts:
    - name: config
      mountPath: /etc/app
  volumes:
  - name: config
    configMap:
      name: app-config
EOF
kubectl -n work-config exec app -- sh -c 'echo $API_KEY; cat /etc/app/APP_MODE'`,
    cleanup: delNs('work-config'),
    docs: `${DOCS}/concepts/configuration/configmap/`,
  },
  {
    id: 'work-tls-cm',
    domain: 'work',
    title: 'Replace an immutable ConfigMap (TLS 1.3 only)',
    difficulty: 'Medium',
    minutes: 7,
    lab: true,
    scenario: `In namespace \`work-tls\` the Deployment \`nginx-static\` reads its server config from the ConfigMap \`nginx-config\`, which currently allows \`TLSv1.2\` and \`TLSv1.3\`. The ConfigMap is **immutable**.

- Change the configuration so that **only \`TLSv1.3\`** is allowed (\`ssl_protocols TLSv1.3;\`). Keep the ConfigMap name \`nginx-config\`.
- Make sure the running Pods pick up the new configuration.`,
    setup: {
      yaml:
        ns('work-tls') +
        `---
apiVersion: v1
kind: ConfigMap
metadata:
  name: nginx-config
  namespace: work-tls
immutable: true
data:
  tls.conf: |
    # included in the http context
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_prefer_server_ciphers on;
` +
        deploy({
          name: 'nginx-static',
          namespace: 'work-tls',
          replicas: 2,
          extra: `
        volumeMounts:
        - name: conf
          mountPath: /etc/nginx/conf.d/tls.conf
          subPath: tls.conf
      volumes:
      - name: conf
        configMap:
          name: nginx-config`,
        }),
    },
    checks: [
      { desc: 'ConfigMap nginx-config allows TLSv1.3 only', args: ['get', 'cm', 'nginx-config', '-n', 'work-tls', '-o', 'jsonpath={.data.tls\\.conf}'], expect: { match: 'ssl_protocols\\s+TLSv1\\.3\\s*;' } },
      { desc: 'Running pods use the new config', args: ['exec', 'deploy/nginx-static', '-n', 'work-tls', '--', 'cat', '/etc/nginx/conf.d/tls.conf'], expect: { match: 'ssl_protocols\\s+TLSv1\\.3\\s*;' } },
      { desc: '2 replicas ready', args: ['get', 'deploy', 'nginx-static', '-n', 'work-tls', '-o', 'jsonpath={.status.readyReplicas}'], expect: { eq: '2' } },
    ],
    hints: ['An immutable ConfigMap cannot be patched or edited — it must be deleted and recreated.', 'Export it first: `kubectl get cm nginx-config -o yaml > cm.yaml`, edit, then `kubectl replace --force -f cm.yaml`.', 'Check the result inside a Pod: `kubectl exec deploy/nginx-static -- cat /etc/nginx/conf.d/tls.conf`. Still the old content after a rollout restart?', 'The kubelet caches immutable ConfigMaps per node for as long as any Pod there still references them. A rolling restart overlaps old and new Pods, so the stale copy survives. Scale to 0, wait for the Pods to disappear, then scale back up.'],
    solution: `kubectl -n work-tls get cm nginx-config -o yaml > cm.yaml
# edit cm.yaml: ssl_protocols TLSv1.3;   (drop resourceVersion/uid/creationTimestamp)

# stop every pod that references the ConfigMap first: the kubelet caches immutable
# ConfigMaps while a pod on the node uses them, and a rolling restart would re-mount
# the stale copy
kubectl -n work-tls scale deploy nginx-static --replicas=0
kubectl -n work-tls wait --for=delete pod -l app=nginx-static --timeout=60s
kubectl replace --force -f cm.yaml           # delete + create, since it is immutable
kubectl -n work-tls scale deploy nginx-static --replicas=2
kubectl -n work-tls rollout status deploy/nginx-static
kubectl -n work-tls exec deploy/nginx-static -- cat /etc/nginx/conf.d/tls.conf
# exam verification: curl --tls-max 1.2 https://<svc>   must now fail`,
    cleanup: delNs('work-tls'),
    cleanupFiles: ['cm.yaml'],
    docs: `${DOCS}/concepts/configuration/configmap/#configmap-immutable`,
  },
  {
    id: 'work-hpa',
    domain: 'work',
    title: 'HorizontalPodAutoscaler with a scale-down window',
    difficulty: 'Medium',
    minutes: 6,
    lab: true,
    scenario: `Create a HorizontalPodAutoscaler \`apache-server\` in namespace \`work-hpa\` for the Deployment \`apache-server\`:

- target **50%** average CPU utilisation
- minimum **1**, maximum **4** replicas
- a scale-**down** stabilisation window of **30 seconds**

Note: the HPA only shows live metrics with metrics-server (\`minikube addons enable metrics-server -p ${PROFILE}\`); the checks validate your spec.`,
    setup: {
      yaml:
        ns('work-hpa') +
        deploy({
          name: 'apache-server',
          namespace: 'work-hpa',
          extra: `
        resources:
          requests:
            cpu: 100m`,
        }),
    },
    checks: [
      { desc: 'HPA targets Deployment apache-server', args: ['get', 'hpa', 'apache-server', '-n', 'work-hpa', '-o', 'jsonpath={.spec.scaleTargetRef.kind}/{.spec.scaleTargetRef.name}'], expect: { eq: 'Deployment/apache-server' } },
      { desc: 'min 1 / max 4 replicas', args: ['get', 'hpa', 'apache-server', '-n', 'work-hpa', '-o', 'jsonpath={.spec.minReplicas}/{.spec.maxReplicas}'], expect: { eq: '1/4' } },
      { desc: 'CPU target 50% utilisation', args: ['get', 'hpa', 'apache-server', '-n', 'work-hpa', '-o', 'jsonpath={.spec.metrics[0].resource.name}:{.spec.metrics[0].resource.target.averageUtilization}'], expect: { eq: 'cpu:50' } },
      { desc: 'scaleDown stabilisation window is 30s', args: ['get', 'hpa', 'apache-server', '-n', 'work-hpa', '-o', 'jsonpath={.spec.behavior.scaleDown.stabilizationWindowSeconds}'], expect: { eq: '30' } },
    ],
    hints: ['`kubectl autoscale deploy apache-server --cpu-percent=50 --min=1 --max=4` creates the HPA; `behavior` must be added afterwards.', 'Add behavior with `kubectl patch hpa ... --type merge -p \'{"spec":{"behavior":{"scaleDown":{"stabilizationWindowSeconds":30}}}}\'` or via the YAML editor.'],
    solution: `kubectl -n work-hpa autoscale deploy apache-server --cpu-percent=50 --min=1 --max=4
kubectl -n work-hpa patch hpa apache-server --type merge \\
  -p '{"spec":{"behavior":{"scaleDown":{"stabilizationWindowSeconds":30}}}}'
kubectl -n work-hpa get hpa apache-server -o yaml

# full manifest
# apiVersion: autoscaling/v2
# kind: HorizontalPodAutoscaler
# spec:
#   scaleTargetRef: {apiVersion: apps/v1, kind: Deployment, name: apache-server}
#   minReplicas: 1
#   maxReplicas: 4
#   metrics:
#   - type: Resource
#     resource: {name: cpu, target: {type: Utilization, averageUtilization: 50}}
#   behavior:
#     scaleDown: {stabilizationWindowSeconds: 30}`,
    cleanup: delNs('work-hpa'),
    docs: `${DOCS}/tasks/run-application/horizontal-pod-autoscale/`,
  },
  {
    id: 'work-priority',
    domain: 'work',
    title: 'PriorityClass for a critical workload',
    difficulty: 'Medium',
    minutes: 5,
    lab: true,
    scenario: `A user-defined PriorityClass \`lab-user-max\` already exists.

- Create a new PriorityClass \`high-priority\` whose value is **exactly one less** than the value of \`lab-user-max\`. It must not be the global default.
- Patch the Deployment \`busybox-logger\` in namespace \`work-priority\` to use it.`,
    setup: {
      yaml:
        ns('work-priority') +
        `---
apiVersion: scheduling.k8s.io/v1
kind: PriorityClass
metadata:
  name: lab-user-max
value: 100000
globalDefault: false
description: Highest user-defined priority in the lab.
` +
        deploy({ name: 'busybox-logger', namespace: 'work-priority', image: BUSYBOX, extra: '\n        command: ["sh", "-c", "while true; do date; sleep 10; done"]' }),
    },
    checks: [
      { desc: 'PriorityClass high-priority has value 99999', args: ['get', 'priorityclass', 'high-priority', '-o', 'jsonpath={.value}'], expect: { eq: '99999' } },
      { desc: 'It is not the global default', args: ['get', 'priorityclass', 'high-priority', '-o', 'jsonpath={.globalDefault}'], expect: { match: '^(false)?$' } },
      { desc: 'Deployment uses high-priority', args: ['get', 'deploy', 'busybox-logger', '-n', 'work-priority', '-o', 'jsonpath={.spec.template.spec.priorityClassName}'], expect: { eq: 'high-priority' } },
      { desc: 'Running pod got priority 99999', args: ['get', 'pods', '-n', 'work-priority', '-l', 'app=busybox-logger', '--field-selector=status.phase=Running', '-o', 'jsonpath={.items[0].spec.priority}'], expect: { eq: '99999' } },
    ],
    hints: ['`kubectl get priorityclass` lists values; ignore the built-in `system-*` classes.', '`kubectl create priorityclass high-priority --value=<n>`', 'The field is `spec.template.spec.priorityClassName`.'],
    solution: `kubectl get priorityclass                       # lab-user-max = 100000
kubectl create priorityclass high-priority --value=99999 --description="one below lab-user-max"
kubectl -n work-priority patch deploy busybox-logger \\
  -p '{"spec":{"template":{"spec":{"priorityClassName":"high-priority"}}}}'
kubectl -n work-priority rollout status deploy/busybox-logger
kubectl -n work-priority get pods -o custom-columns=NAME:.metadata.name,PRIO:.spec.priority`,
    cleanup: [...delNs('work-priority'), ['delete', 'priorityclass', 'high-priority', 'lab-user-max', '--ignore-not-found']],
    docs: `${DOCS}/concepts/scheduling-eviction/pod-priority-preemption/`,
  },
  {
    id: 'work-sidecar',
    domain: 'work',
    title: 'Add a log-shipping sidecar',
    difficulty: 'Medium',
    minutes: 8,
    lab: true,
    scenario: `The Deployment \`synergy\` in namespace \`work-sidecar\` writes its log to \`/var/log/synergy.log\` inside the container, where nothing can read it.

Update the Deployment:
- add a container named \`sidecar\` (image \`${BUSYBOX}\`) running \`/bin/sh -c "tail -n+1 -f /var/log/synergy.log"\`
- share the directory \`/var/log\` between both containers with a volume (use an \`emptyDir\`)

A classic co-located container or a native sidecar (init container with \`restartPolicy: Always\`) are both accepted.`,
    setup: {
      yaml:
        ns('work-sidecar') +
        deploy({
          name: 'synergy',
          namespace: 'work-sidecar',
          image: BUSYBOX,
          extra: `
        command: ["sh", "-c", "while true; do echo \\"$(date) synergy heartbeat\\" >> /var/log/synergy.log; sleep 3; done"]`,
        }),
    },
    checks: [
      { desc: 'A container named sidecar exists', args: ['get', 'deploy', 'synergy', '-n', 'work-sidecar', '-o', 'jsonpath={.spec.template.spec.containers[*].name} {.spec.template.spec.initContainers[*].name}'], expect: { match: '\\bsidecar\\b' } },
      { desc: 'Pod uses an emptyDir volume', args: ['get', 'deploy', 'synergy', '-n', 'work-sidecar', '-o', 'jsonpath={.spec.template.spec.volumes[*].emptyDir}'], expect: { nonEmpty: true } },
      { desc: 'Deployment is available', args: ['get', 'deploy', 'synergy', '-n', 'work-sidecar', '-o', 'jsonpath={.status.availableReplicas}'], expect: { eq: '1' } },
      { desc: 'Sidecar streams the application log', args: ['logs', 'deploy/synergy', '-n', 'work-sidecar', '-c', 'sidecar', '--tail=3'], expect: { contains: 'synergy heartbeat' } },
    ],
    hints: ['Load the Deployment into the YAML editor ("Load from cluster"), edit, Apply.', 'Three additions: a `volumes:` entry, a `volumeMounts:` on the existing container, and the new container with the same mount.'],
    solution: `kubectl -n work-sidecar get deploy synergy -o yaml > synergy.yaml
# edit spec.template.spec:
#   containers:
#   - name: synergy
#     ...
#     volumeMounts:
#     - name: logs
#       mountPath: /var/log
#   - name: sidecar
#     image: busybox:1.36
#     command: ["/bin/sh", "-c", "tail -n+1 -f /var/log/synergy.log"]
#     volumeMounts:
#     - name: logs
#       mountPath: /var/log
#   volumes:
#   - name: logs
#     emptyDir: {}
kubectl apply -f synergy.yaml
kubectl -n work-sidecar logs deploy/synergy -c sidecar

# native sidecar variant (GA): put the sidecar under initContainers with
#   restartPolicy: Always`,
    cleanup: delNs('work-sidecar'),
    cleanupFiles: ['synergy.yaml'],
    docs: `${DOCS}/concepts/workloads/pods/sidecar-containers/`,
  },
  {
    id: 'work-quota',
    domain: 'work',
    title: 'Fit a Deployment into a ResourceQuota',
    difficulty: 'Medium',
    minutes: 8,
    lab: true,
    scenario: `Deployment \`wordpress\` in namespace \`work-quota\` wants **3** replicas but has none: a ResourceQuota rejects its Pods.

- Find out why the Pods are not created.
- Give the container resource **requests equal to its limits** (QoS class \`Guaranteed\`), sized so that all 3 replicas fit into the quota with an equal share each.
- Do not change the quota or the replica count.`,
    setup: {
      yaml:
        ns('work-quota') +
        `---
apiVersion: v1
kind: ResourceQuota
metadata:
  name: compute
  namespace: work-quota
spec:
  hard:
    requests.cpu: 600m
    requests.memory: 600Mi
    limits.cpu: 600m
    limits.memory: 600Mi
` +
        deploy({ name: 'wordpress', namespace: 'work-quota', replicas: 3 }),
    },
    checks: [
      { desc: '3 replicas are ready', args: ['get', 'deploy', 'wordpress', '-n', 'work-quota', '-o', 'jsonpath={.status.readyReplicas}'], expect: { eq: '3' } },
      { desc: 'All pods are QoS Guaranteed', args: ['get', 'pods', '-n', 'work-quota', '-l', 'app=wordpress', '--field-selector=status.phase=Running', '-o', 'jsonpath={.items[*].status.qosClass}'], expect: { eq: 'Guaranteed Guaranteed Guaranteed' } },
      { desc: 'Quota unchanged', args: ['get', 'quota', 'compute', '-n', 'work-quota', '-o', 'jsonpath={.spec.hard.limits\\.cpu}/{.spec.hard.limits\\.memory}'], expect: { eq: '600m/600Mi' } },
    ],
    hints: ['No Pods at all → the ReplicaSet is failing to create them. `kubectl describe rs` shows: "failed quota: compute: must specify limits.cpu, ..."', '`kubectl describe quota compute` shows the hard limits. Divide by 3.', '`kubectl set resources deploy wordpress --requests=cpu=..,memory=.. --limits=cpu=..,memory=..`'],
    solution: `kubectl -n work-quota get deploy,rs,pods
kubectl -n work-quota describe rs                      # Events: forbidden: failed quota ... must specify limits/requests
kubectl -n work-quota describe quota compute           # 600m / 600Mi  ->  200m / 200Mi per pod
kubectl -n work-quota set resources deploy wordpress \\
  --requests=cpu=200m,memory=200Mi --limits=cpu=200m,memory=200Mi
kubectl -n work-quota rollout status deploy/wordpress
kubectl -n work-quota get pods -o custom-columns=NAME:.metadata.name,QOS:.status.qosClass
# a rollout that surges needs head-room; if it stalls, scale to 0 and back to 3`,
    cleanup: delNs('work-quota'),
    docs: `${DOCS}/concepts/policy/resource-quotas/`,
  },
  {
    id: 'work-schedule',
    domain: 'work',
    title: 'Taints, tolerations and node selection',
    difficulty: 'Medium',
    minutes: 7,
    lab: true,
    scenario: `Dedicate **one worker node** of your cluster to GPU workloads:

- Taint exactly one node with \`dedicated=gpu:NoSchedule\` and label that same node \`hardware=gpu\`.
- In namespace \`work-schedule\` create a Pod \`gpu-job\` (image \`${BUSYBOX}\`, command \`sleep 1d\`) that tolerates the taint **and** is forced onto that node through the label.

Clean up afterwards — the cleanup button removes the taint and label from all nodes.`,
    setup: { yaml: ns('work-schedule') },
    checks: [
      { desc: 'Exactly one node is labelled hardware=gpu and tainted dedicated:NoSchedule', args: ['get', 'nodes', '-l', 'hardware=gpu', '-o', 'jsonpath={range .items[*]}{.spec.taints[?(@.key=="dedicated")].value}:{.spec.taints[?(@.key=="dedicated")].effect} {end}'], expect: { eq: 'gpu:NoSchedule' } },
      { desc: 'Pod gpu-job is Running', args: ['get', 'pod', 'gpu-job', '-n', 'work-schedule', '-o', 'jsonpath={.status.phase}'], expect: { eq: 'Running' } },
      { desc: 'Pod tolerates dedicated=gpu:NoSchedule', args: ['get', 'pod', 'gpu-job', '-n', 'work-schedule', '-o', 'jsonpath={.spec.tolerations[?(@.key=="dedicated")].effect}'], expect: { eq: 'NoSchedule' } },
      { desc: 'Pod selects the node by label hardware=gpu', args: ['get', 'pod', 'gpu-job', '-n', 'work-schedule', '-o', 'jsonpath={.spec.nodeSelector.hardware}{.spec.affinity.nodeAffinity.requiredDuringSchedulingIgnoredDuringExecution.nodeSelectorTerms[*].matchExpressions[?(@.key=="hardware")].values[*]}'], expect: { eq: 'gpu' } },
    ],
    hints: ['A toleration only *permits* scheduling onto the tainted node; it does not attract the Pod. That is what nodeSelector / nodeAffinity is for.', '`kubectl taint nodes <node> dedicated=gpu:NoSchedule` and `kubectl label nodes <node> hardware=gpu`.'],
    solution: `kubectl get nodes
kubectl taint nodes ${PROFILE}-m02 dedicated=gpu:NoSchedule
kubectl label nodes ${PROFILE}-m02 hardware=gpu

kubectl apply -f - <<EOF
apiVersion: v1
kind: Pod
metadata:
  name: gpu-job
  namespace: work-schedule
spec:
  nodeSelector:
    hardware: gpu
  tolerations:
  - key: dedicated
    operator: Equal
    value: gpu
    effect: NoSchedule
  containers:
  - name: gpu-job
    image: busybox:1.36
    command: ["sleep", "1d"]
EOF
kubectl -n work-schedule get pod gpu-job -o wide

# remove again:
#   kubectl taint nodes ${PROFILE}-m02 dedicated-
#   kubectl label nodes ${PROFILE}-m02 hardware-`,
    cleanup: [...delNs('work-schedule'), ['taint', 'nodes', '--all', 'dedicated-'], ['label', 'nodes', '--all', 'hardware-']],
    docs: `${DOCS}/concepts/scheduling-eviction/taint-and-toleration/`,
  },

  // ───────────────────────── Storage (10%) ─────────────────────────
  {
    id: 'stor-class',
    domain: 'stor',
    title: 'Create a StorageClass and make it the default',
    difficulty: 'Medium',
    minutes: 5,
    lab: true,
    scenario: `- Create a StorageClass \`lab-local-path\` with provisioner \`rancher.io/local-path\`, volume binding mode \`WaitForFirstConsumer\` and reclaim policy \`Delete\`.
- Make it the cluster's **default** StorageClass.
- Make sure **no other** StorageClass is still marked as default.

Cleanup deletes \`lab-local-path\` and marks minikube's \`standard\` class as default again.`,
    checks: [
      { desc: 'Provisioner is rancher.io/local-path', args: ['get', 'sc', 'lab-local-path', '-o', 'jsonpath={.provisioner}'], expect: { eq: 'rancher.io/local-path' } },
      { desc: 'volumeBindingMode is WaitForFirstConsumer', args: ['get', 'sc', 'lab-local-path', '-o', 'jsonpath={.volumeBindingMode}'], expect: { eq: 'WaitForFirstConsumer' } },
      { desc: 'lab-local-path is default', args: ['get', 'sc', 'lab-local-path', '-o', 'jsonpath={.metadata.annotations.storageclass\\.kubernetes\\.io/is-default-class}'], expect: { eq: 'true' } },
      { desc: 'It is the only default StorageClass', args: ['get', 'sc', '-o', 'jsonpath={range .items[*]}{.metadata.annotations.storageclass\\.kubernetes\\.io/is-default-class}{" "}{end}'], expect: { match: '^(?!(?:.*true){2}).*true' } },
    ],
    hints: ['There is no `kubectl create storageclass` — write the YAML (`storage.k8s.io/v1`).', 'Default = annotation `storageclass.kubernetes.io/is-default-class: "true"`.', '`kubectl get sc` marks defaults with "(default)". Patch the old one to `"false"`.'],
    solution: `kubectl get sc
kubectl apply -f - <<EOF
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: lab-local-path
  annotations:
    storageclass.kubernetes.io/is-default-class: "true"
provisioner: rancher.io/local-path
volumeBindingMode: WaitForFirstConsumer
reclaimPolicy: Delete
EOF
kubectl patch sc standard \\
  -p '{"metadata":{"annotations":{"storageclass.kubernetes.io/is-default-class":"false"}}}'
kubectl get sc`,
    cleanup: [
      ['delete', 'sc', 'lab-local-path', '--ignore-not-found'],
      ['patch', 'sc', 'standard', '-p', '{"metadata":{"annotations":{"storageclass.kubernetes.io/is-default-class":"true"}}}'],
    ],
    docs: `${DOCS}/concepts/storage/storage-classes/`,
  },
  {
    id: 'stor-pv',
    domain: 'stor',
    title: 'PersistentVolume, claim and Pod',
    difficulty: 'Medium',
    minutes: 8,
    lab: true,
    scenario: `- Create a PersistentVolume \`lab-pv-data\`: capacity \`1Gi\`, access mode \`ReadWriteOnce\`, reclaim policy \`Retain\`, storage class name \`manual\`, \`hostPath\` \`/mnt/lab-pv-data\`.
- In namespace \`stor-pv\` create a PersistentVolumeClaim \`data-claim\` requesting \`500Mi\`, \`ReadWriteOnce\`, storage class \`manual\`. It must bind to your PV.
- Create a Pod \`data-pod\` (image \`${NGINX}\`) mounting the claim at \`/usr/share/nginx/html\`.`,
    setup: { yaml: ns('stor-pv') },
    checks: [
      { desc: 'PV: 1Gi, RWO, Retain, class manual', args: ['get', 'pv', 'lab-pv-data', '-o', 'jsonpath={.spec.capacity.storage}/{.spec.accessModes[0]}/{.spec.persistentVolumeReclaimPolicy}/{.spec.storageClassName}'], expect: { eq: '1Gi/ReadWriteOnce/Retain/manual' } },
      { desc: 'PV uses hostPath /mnt/lab-pv-data', args: ['get', 'pv', 'lab-pv-data', '-o', 'jsonpath={.spec.hostPath.path}'], expect: { eq: '/mnt/lab-pv-data' } },
      { desc: 'PVC data-claim is Bound to lab-pv-data', args: ['get', 'pvc', 'data-claim', '-n', 'stor-pv', '-o', 'jsonpath={.status.phase}/{.spec.volumeName}'], expect: { eq: 'Bound/lab-pv-data' } },
      { desc: 'PVC requests 500Mi', args: ['get', 'pvc', 'data-claim', '-n', 'stor-pv', '-o', 'jsonpath={.spec.resources.requests.storage}'], expect: { eq: '500Mi' } },
      { desc: 'Pod data-pod is Running', args: ['get', 'pod', 'data-pod', '-n', 'stor-pv', '-o', 'jsonpath={.status.phase}'], expect: { eq: 'Running' } },
      { desc: 'Claim mounted at /usr/share/nginx/html', args: ['get', 'pod', 'data-pod', '-n', 'stor-pv', '-o', 'jsonpath={.spec.volumes[?(@.persistentVolumeClaim.claimName=="data-claim")].name}={.spec.containers[0].volumeMounts[?(@.mountPath=="/usr/share/nginx/html")].name}'], expect: { match: '^(.+)=\\1$' } },
    ],
    hints: ['PV/PVC have no imperative commands. Docs: "Configure a Pod to Use a PersistentVolume for Storage" has all three manifests.', 'A PVC binds when storageClassName and access mode match and the PV capacity is ≥ the request.'],
    solution: `kubectl apply -f - <<EOF
apiVersion: v1
kind: PersistentVolume
metadata:
  name: lab-pv-data
spec:
  capacity:
    storage: 1Gi
  accessModes: ["ReadWriteOnce"]
  persistentVolumeReclaimPolicy: Retain
  storageClassName: manual
  hostPath:
    path: /mnt/lab-pv-data
---
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: data-claim
  namespace: stor-pv
spec:
  accessModes: ["ReadWriteOnce"]
  storageClassName: manual
  resources:
    requests:
      storage: 500Mi
---
apiVersion: v1
kind: Pod
metadata:
  name: data-pod
  namespace: stor-pv
spec:
  containers:
  - name: web
    image: nginx:1.27-alpine
    volumeMounts:
    - name: data
      mountPath: /usr/share/nginx/html
  volumes:
  - name: data
    persistentVolumeClaim:
      claimName: data-claim
EOF
kubectl get pv
kubectl -n stor-pv get pvc,pod`,
    cleanup: [...delNs('stor-pv'), ['delete', 'pv', 'lab-pv-data', '--ignore-not-found']],
    docs: `${DOCS}/tasks/configure-pod-container/configure-persistent-volume-storage/`,
  },
  {
    id: 'stor-retain',
    domain: 'stor',
    title: 'Reuse a retained PersistentVolume',
    difficulty: 'Hard',
    minutes: 9,
    lab: true,
    scenario: `A database was deleted, but its data survives on the retained PersistentVolume \`lab-mariadb-pv\` (status \`Available\`, no storage class).

- In namespace \`stor-retain\` create a PersistentVolumeClaim \`mariadb\` (\`250Mi\`, \`ReadWriteOnce\`) that binds to **exactly that PV** — it must not trigger dynamic provisioning.
- Update the existing Deployment \`mariadb\` so that it mounts the claim at \`/var/lib/mysql\`, and make sure it is running.`,
    setup: {
      yaml:
        ns('stor-retain') +
        `---
apiVersion: v1
kind: PersistentVolume
metadata:
  name: lab-mariadb-pv
spec:
  capacity:
    storage: 250Mi
  accessModes: ["ReadWriteOnce"]
  persistentVolumeReclaimPolicy: Retain
  storageClassName: ""
  hostPath:
    path: /mnt/lab-mariadb
` +
        deploy({ name: 'mariadb', namespace: 'stor-retain', image: BUSYBOX, extra: '\n        command: ["sh", "-c", "sleep 1d"]' }),
    },
    checks: [
      { desc: 'PVC mariadb is Bound to lab-mariadb-pv', args: ['get', 'pvc', 'mariadb', '-n', 'stor-retain', '-o', 'jsonpath={.status.phase}/{.spec.volumeName}'], expect: { eq: 'Bound/lab-mariadb-pv' } },
      { desc: 'PVC requests 250Mi RWO', args: ['get', 'pvc', 'mariadb', '-n', 'stor-retain', '-o', 'jsonpath={.spec.resources.requests.storage}/{.spec.accessModes[0]}'], expect: { eq: '250Mi/ReadWriteOnce' } },
      { desc: 'Deployment mounts the claim at /var/lib/mysql', args: ['get', 'deploy', 'mariadb', '-n', 'stor-retain', '-o', 'jsonpath={.spec.template.spec.volumes[?(@.persistentVolumeClaim.claimName=="mariadb")].name}={.spec.template.spec.containers[0].volumeMounts[?(@.mountPath=="/var/lib/mysql")].name}'], expect: { match: '^(.+)=\\1$' } },
      { desc: 'Deployment is available', args: ['get', 'deploy', 'mariadb', '-n', 'stor-retain', '-o', 'jsonpath={.status.availableReplicas}'], expect: { eq: '1' } },
    ],
    hints: ['If the PVC omits `storageClassName`, the **default** class is used and a new volume is provisioned. Set `storageClassName: ""` to match the PV.', '`spec.volumeName: lab-mariadb-pv` pins the claim to that PV.', 'A retained PV in state `Released` still has a `claimRef`; clear it with `kubectl patch pv <pv> --type json -p \'[{"op":"remove","path":"/spec/claimRef"}]\'` to make it Available again.'],
    solution: `kubectl get pv lab-mariadb-pv -o yaml          # capacity, accessModes, storageClassName ""
kubectl apply -f - <<EOF
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: mariadb
  namespace: stor-retain
spec:
  accessModes: ["ReadWriteOnce"]
  storageClassName: ""
  volumeName: lab-mariadb-pv
  resources:
    requests:
      storage: 250Mi
EOF
kubectl -n stor-retain get pvc                 # Bound

kubectl -n stor-retain patch deploy mariadb --type json -p '[
  {"op":"add","path":"/spec/template/spec/volumes","value":[{"name":"data","persistentVolumeClaim":{"claimName":"mariadb"}}]},
  {"op":"add","path":"/spec/template/spec/containers/0/volumeMounts","value":[{"name":"data","mountPath":"/var/lib/mysql"}]}
]'
kubectl -n stor-retain rollout status deploy/mariadb`,
    cleanup: [...delNs('stor-retain'), ['delete', 'pv', 'lab-mariadb-pv', '--ignore-not-found']],
    docs: `${DOCS}/concepts/storage/persistent-volumes/`,
  },
];

const examInfo = {
  facts: [
    ['Format', 'Performance-based: you solve tasks on real clusters from a remote Linux desktop (PSI). No multiple choice.'],
    ['Duration', '2 hours'],
    ['Tasks', 'About 15–20 (candidates in 2026 report 16–17)'],
    ['Passing score', '66%'],
    ['Kubernetes version', 'v1.35 (current curriculum document; confirm on the exam page before booking)'],
    ['Allowed docs', 'kubernetes.io/docs, kubernetes.io/blog, and the docs of tools used in a task (e.g. helm.sh, gateway-api.sigs.k8s.io)'],
    ['Included', 'One free retake and two killer.sh simulator sessions'],
    ['Validity', '2 years'],
  ],
  tips: [
    'Every task starts with an `ssh <host>` command — run it, and `exit` back before the next task. Work done on the wrong host scores zero.',
    'Read the whole task first. The namespace, exact resource names and output paths are what the grader checks.',
    'Troubleshooting is 30%: practise `describe` → `logs` → `events` on workloads, and `systemctl` / `journalctl` / `crictl` on nodes.',
    'Generate YAML instead of writing it: `--dry-run=client -o yaml`. For objects without a generator (PV, PVC, NetworkPolicy, StorageClass, Gateway) copy from the docs.',
    'Flag long tasks and come back. Tasks carry different weights; do not sink 15 minutes into a 4% task.',
    'Verify every task before moving on: `kubectl get`, `auth can-i`, a test Pod with `wget`/`nslookup`.',
    'Only `k` and bash completion are preconfigured. Practise typing `--dry-run=client -o yaml` and `--force --grace-period=0` in full.',
    '`kubectl explain <resource>.<field> --recursive` is faster than the docs when you only need a field name.',
  ],
  sources: [
    ['Official CKA curriculum v1.35 (CNCF)', 'https://github.com/cncf/curriculum/blob/master/CKA_Curriculum_v1.35.pdf'],
    ['Linux Foundation — CKA exam page', 'https://training.linuxfoundation.org/certification/certified-kubernetes-administrator-cka/'],
    ['I passed the CKA! My Exam Experience (2026) — D. Cassisi', 'https://dcassisi.com/2026/06/09/i-passed-the-cka-my-exam-experience-2026/'],
    ['CKA Certification Guide 2026 (study notes, 89%)', 'https://github.com/techwithmohamed/CKA-Certified-Kubernetes-Administrator'],
    ['CKA exam topics mapped to the curriculum — prepium.sh', 'https://prepium.sh/topics.html'],
    ['CKA 2025 question walkthroughs (YouTube playlist) — DumbITGuy', 'https://youtube.com/playlist?list=PLvZb3tGyqC1TOasSaN36haM5xlCxHQBlA'],
  ],
};

const cheatsheet = [
  {
    title: 'Speed basics',
    items: [
      ['Generate YAML', 'kubectl run web --image=nginx --dry-run=client -o yaml'],
      ['Deployment YAML', 'kubectl create deploy web --image=nginx --replicas=3 --dry-run=client -o yaml'],
      ['Field docs', 'kubectl explain deploy.spec.strategy --recursive'],
      ['Find the resource kind', 'kubectl api-resources | grep -i gateway'],
      ['Replace immutable object', 'kubectl replace --force -f file.yaml'],
      ['Delete fast', 'kubectl delete pod web --force --grace-period=0'],
      ['Default namespace', 'kubectl config set-context --current --namespace=dev'],
    ],
  },
  {
    title: 'Inspecting & output',
    items: [
      ['Everything, wide', 'kubectl get pods -A -o wide'],
      ['Sort', 'kubectl get pods -A --sort-by=.metadata.creationTimestamp'],
      ['jsonpath', "kubectl get nodes -o jsonpath='{.items[*].status.addresses[?(@.type==\"InternalIP\")].address}'"],
      ['Custom columns', 'kubectl get pods -o custom-columns=NAME:.metadata.name,NODE:.spec.nodeName'],
      ['Filter', 'kubectl get pods --field-selector=status.phase!=Running -A'],
      ['Events, newest last', 'kubectl get events -A --sort-by=.lastTimestamp'],
      ['Usage', 'kubectl top pod -A --sort-by=cpu'],
    ],
  },
  {
    title: 'Workloads',
    items: [
      ['Update image', 'kubectl set image deploy/web web=nginx:1.27'],
      ['Rollout', 'kubectl rollout status|history|undo|restart deploy/web'],
      ['Resources', 'kubectl set resources deploy web --requests=cpu=100m,memory=64Mi --limits=cpu=200m,memory=128Mi'],
      ['Autoscale', 'kubectl autoscale deploy web --cpu-percent=50 --min=1 --max=4'],
      ['ConfigMap / Secret', 'kubectl create cm app --from-literal=k=v ; kubectl create secret generic s --from-literal=k=v'],
      ['PriorityClass', 'kubectl create priorityclass high --value=1000'],
      ['Test pod', 'kubectl run t --rm -it --restart=Never --image=busybox:1.36 -- sh'],
    ],
  },
  {
    title: 'Nodes & scheduling',
    items: [
      ['Maintenance', 'kubectl drain node01 --ignore-daemonsets --delete-emptydir-data ; kubectl uncordon node01'],
      ['Taint / untaint', 'kubectl taint nodes node01 key=value:NoSchedule ; kubectl taint nodes node01 key-'],
      ['Label', 'kubectl label nodes node01 disk=ssd'],
      ['Node debug shell', 'kubectl debug node/node01 -it --image=busybox:1.36'],
      ['Static pods', '/etc/kubernetes/manifests/  (kubelet staticPodPath)'],
    ],
  },
  {
    title: 'RBAC',
    items: [
      ['Role', 'kubectl create role r --verb=get,list --resource=pods -n dev'],
      ['Bind to SA', 'kubectl create rolebinding rb --role=r --serviceaccount=dev:sa -n dev'],
      ['ClusterRole', 'kubectl create clusterrole cr --verb=get,list --resource=nodes'],
      ['Bind to user', 'kubectl create clusterrolebinding crb --clusterrole=cr --user=jane'],
      ['Check', 'kubectl auth can-i list pods -n dev --as=system:serviceaccount:dev:sa'],
    ],
  },
  {
    title: 'Networking',
    items: [
      ['Expose', 'kubectl expose deploy web --port=80 --target-port=8080 --type=NodePort'],
      ['Ingress', 'kubectl create ingress web --class=nginx --rule="host.com/path*=svc:80"'],
      ['Endpoints', 'kubectl get endpointslices -l kubernetes.io/service-name=web'],
      ['DNS name', '<svc>.<namespace>.svc.cluster.local'],
      ['Gateway API kinds', 'kubectl get gatewayclass,gateway,httproute -A'],
      ['CoreDNS config', 'kubectl -n kube-system get cm coredns -o yaml'],
    ],
  },
  {
    title: 'Node-level troubleshooting',
    items: [
      ['kubelet', 'systemctl status kubelet ; journalctl -u kubelet -n 50 --no-pager'],
      ['Containers', 'crictl ps -a ; crictl logs <id> ; crictl pods'],
      ['kubelet config', '/var/lib/kubelet/config.yaml  /var/lib/kubelet/kubeadm-flags.env  /etc/kubernetes/kubelet.conf'],
      ['Certificates', 'kubeadm certs check-expiration ; openssl x509 -in /etc/kubernetes/pki/apiserver.crt -noout -text'],
      ['Pod logs on disk', '/var/log/pods/  /var/log/containers/'],
    ],
  },
  {
    title: 'Cluster lifecycle',
    items: [
      ['Join command', 'kubeadm token create --print-join-command'],
      ['Upgrade', 'kubeadm upgrade plan ; kubeadm upgrade apply v1.35.1 ; kubeadm upgrade node'],
      ['etcd backup', 'ETCDCTL_API=3 etcdctl --endpoints=https://127.0.0.1:2379 --cacert=<ca> --cert=<crt> --key=<key> snapshot save /opt/backup.db'],
      ['etcd restore', 'etcdutl snapshot restore /opt/backup.db --data-dir /var/lib/etcd-restore'],
      ['Helm', 'helm repo add|update ; helm install|upgrade|rollback|uninstall ; helm template ; helm show values'],
      ['Kustomize', 'kubectl kustomize dir/ ; kubectl apply -k dir/'],
    ],
  },
];

module.exports = { tasks, domains, examInfo, cheatsheet, helpers: { NGINX, BUSYBOX, DOCS, PROFILE, ns, deploy, delNs } };
