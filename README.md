# CKA Practice Lab

A local webapp for preparing for the Certified Kubernetes Administrator exam. It combines a task
bank mapped to the official curriculum with a kubectl console that runs against your minikube
cluster, and it grades lab tasks automatically.

## Run

```bash
minikube start        # if the cluster is not running
npm start             # or: node server.js
```

Open <http://localhost:8377>, or `http://<this-machine's-ip>:8377` from another device on your
network (the addresses are printed at startup). No dependencies to install (Node 18+).

| Variable       | Default    | Meaning                                         |
| -------------- | ---------- | ----------------------------------------------- |
| `PORT`         | `8377`     | Port to listen on                               |
| `HOST`         | `0.0.0.0`  | Bind address; `127.0.0.1` for this machine only |
| `KUBE_CONTEXT` | `minikube` | kubectl context every command is pinned to      |

## What is in it

- **Overview** — exam facts, the five domains with their weights and competencies, your progress.
- **Practice** — 37 tasks. *Lab* tasks have **Set up / reset**, **Verify** and **Clean up** buttons: setup
  creates a namespace with the scenario (often something broken), Verify runs checks against the
  cluster. *Walkthroughs* cover node-level topics (kubeadm upgrade, etcd, kubelet, control-plane
  repair, cri-dockerd, CNI) with a reference solution and notes on practising via `minikube ssh`.
- **Scenarios** — 16 exam questions as candidates report them, adapted from DumbITGuy's "CKA 2025"
  YouTube playlist: 13 graded labs and 3 walkthroughs, each linking to the video it follows. They
  use the exam's own resource names and are kept out of the mock exam.
- **Mock exam** — 15 random lab tasks weighted like the exam, 120-minute timer, hints hidden,
  graded at the end against the 66% pass mark.
- **Cheat sheet** — click a command to drop it into the terminal.
- **Console** (right side)
  - *Terminal*: `kubectl …` or `k …`, history with ↑/↓, multi-line paste, `<<EOF` heredocs,
    `> file` to save output into `workspace/`, `kubectl edit` with an inline editor.
  - *YAML editor*: write or paste manifests, Apply / Dry-run / Delete, save and open workspace
    files, and "Load from cluster" to edit a live object.

Some tasks need minikube addons: `minikube addons enable metrics-server` (for `kubectl top` and
live HPA metrics) and optionally `minikube addons enable ingress`. Install `helm` and restart the
server to use helm in the console.

## Console limits

Commands are executed directly, without a shell: only `kubectl` (and `helm` when installed), one
command per line. Pipes, `&&`, `exec -it` and `port-forward` are not available; commands are
stopped after 30 s (`rollout status` and `wait` get 2 min).

`kubectl edit` (also `apply edit-last-applied` and `create --edit`) works: kubectl runs with
`edit-helper.js` as its `KUBE_EDITOR`, and the file it wants edited opens in the terminal pane.
Save & quit hands it back to kubectl, which validates and reopens it on errors just like vi would;
Cancel leaves it unchanged. An edit left open for 30 min is abandoned. Flags that would point
kubectl at another cluster (`--context`, `--kubeconfig`, `--server`, …) are rejected.

The server listens on all interfaces so you can use it from other devices on your LAN. It has no
login: anyone who can reach the port can run kubectl against your cluster. Use it only on a network
you trust, never forward the port to the internet, and start it with `HOST=127.0.0.1` elsewhere.
It still rejects requests whose `Host` is not one of this machine's own names or addresses, and
writes that do not come from its own page, so other websites open in your browser cannot drive it.

## Adding tasks

Tasks live in `tasks.js`. A lab task has `setup` (`yaml`, optional `pre`/`post` kubectl argument
lists, optional workspace `files`), `checks` (a kubectl argument list or a workspace `file`, plus an
`expect` of `eq` / `contains` / `match` / `notMatch` / `gte` / `nonEmpty` / `exit`) and `cleanup`.
Scenarios live in `scenarios.js` in the same shape, plus `num` and the `videos` they credit.

## Sources

Domains and weights come from the [CNCF CKA curriculum v1.35](https://github.com/cncf/curriculum).
Task themes follow recent candidate reports; see the Overview page for links. The Scenarios section
is adapted from the ["CKA 2025" playlist](https://youtube.com/playlist?list=PLvZb3tGyqC1TOasSaN36haM5xlCxHQBlA)
by [DumbITGuy](https://www.youtube.com/@dumbitguy7000) on YouTube. Check the
[Linux Foundation exam page](https://training.linuxfoundation.org/certification/certified-kubernetes-administrator-cka/)
for the current version and rules before booking.
