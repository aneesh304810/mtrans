// ============================================================
// Jenkinsfile — Shared Developer VM on OpenShift
// Model      : One pod, multiple developers, per-user isolation
// Base Image : image-registry.openshift-image-registry.svc:5000/
//              is-prbk-airflow-q/airflow:latest
// Supports   : VS Code Remote-SSH + code-server (browser)
// Max Users  : 2-5 developers
// ============================================================

pipeline {

    agent {
        label 'jenkins-agent-oc'
    }

    // ── Parameters ────────────────────────────────────────────
    parameters {

        // ── Action to perform ─────────────────────────────────
        choice(
            name: 'ACTION',
            choices: [
                'PROVISION_VM',        // Create the shared VM (run once)
                'ADD_DEVELOPER',       // Add a new developer user to VM
                'REMOVE_DEVELOPER',    // Remove a developer user
                'RESTART_VM',          // Restart the shared pod
                'STATUS'               // Show current VM + user status
            ],
            description: 'Action to perform on the shared developer VM'
        )

        // ── Shared VM config (used for PROVISION_VM) ──────────
        choice(
            name: 'NAMESPACE',
            choices: [
                'is-prbk-airflow-d',
                'is-prbk-airflow-q',
                'is-prbk-airflow-p'
            ],
            description: 'Target OpenShift namespace'
        )
        choice(
            name: 'TOTAL_CPU',
            choices: ['4', '8', '12', '16'],
            description: 'Total CPU cores for the shared VM (shared across all developers)'
        )
        choice(
            name: 'TOTAL_MEMORY',
            choices: ['16Gi', '24Gi', '32Gi', '48Gi'],
            description: 'Total memory for the shared VM (shared across all developers)'
        )
        string(
            name: 'SHARED_PVC_SIZE',
            defaultValue: '100Gi',
            description: 'Total persistent storage (shared, partitioned per user under /home)'
        )

        // ── Developer user (used for ADD/REMOVE_DEVELOPER) ────
        string(
            name: 'DEVELOPER_USERNAME',
            defaultValue: '',
            description: 'BBH AD username to add or remove (e.g. jsmith)'
        )
        string(
            name: 'DEVELOPER_FULLNAME',
            defaultValue: '',
            description: 'Full name for Airflow user creation (e.g. John Smith)'
        )

        // ── Port offset (unique per user, avoids conflicts) ───
        choice(
            name: 'USER_PORT_OFFSET',
            choices: ['0', '1', '2', '3', '4'],
            description: '''Port offset for this developer (must be unique per user):
0 → Airflow:8080  Jupyter:8888  VS Code:8443  SSH:2220
1 → Airflow:8081  Jupyter:8889  VS Code:8444  SSH:2221
2 → Airflow:8082  Jupyter:8890  VS Code:8445  SSH:2222
3 → Airflow:8083  Jupyter:8891  VS Code:8446  SSH:2223
4 → Airflow:8084  Jupyter:8892  VS Code:8447  SSH:2224'''
        )

        booleanParam(
            name: 'FORCE_RECREATE_VM',
            defaultValue: false,
            description: 'PROVISION_VM only: delete and recreate the shared VM (PVC preserved)'
        )
    }

    // ── Environment ───────────────────────────────────────────
    environment {
        BASE_IMAGE       = 'image-registry.openshift-image-registry.svc:5000/is-prbk-airflow-q/airflow:latest'
        OC_SERVER        = 'https://api.openshift.bbh.com:6443'
        OC_TOKEN         = credentials('openshift-sa-token')
        OPENSHIFT_DOMAIN = 'apps.openshift.bbh.com'
        SHARED_VM_NAME   = 'shared-dev-vm'
    }

    options {
        timeout(time: 30, unit: 'MINUTES')
        buildDiscarder(logRotator(numToKeepStr: '30'))
        ansiColor('xterm')
    }

    // ── Stages ────────────────────────────────────────────────
    stages {

        // ─────────────────────────────────────────────────────
        // Stage 1 — Validate
        // ─────────────────────────────────────────────────────
        stage('Validate') {
            steps {
                script {
                    echo "==> Action: ${params.ACTION}"

                    // Username required for user-level actions
                    if (params.ACTION in ['ADD_DEVELOPER', 'REMOVE_DEVELOPER']) {
                        if (!params.DEVELOPER_USERNAME?.trim()) {
                            error "❌ DEVELOPER_USERNAME is required for ${params.ACTION}"
                        }
                        if (!(params.DEVELOPER_USERNAME ==~ /^[a-z0-9][a-z0-9]{0,30}$/)) {
                            error "❌ DEVELOPER_USERNAME must be lowercase alphanumeric only (no hyphens — Linux username constraint)"
                        }
                    }

                    if (params.ACTION == 'ADD_DEVELOPER' && !params.DEVELOPER_FULLNAME?.trim()) {
                        error "❌ DEVELOPER_FULLNAME is required for ADD_DEVELOPER"
                    }

                    echo "✅ Validation passed"
                }
            }
        }

        // ─────────────────────────────────────────────────────
        // Stage 2 — OpenShift Login
        // ─────────────────────────────────────────────────────
        stage('OpenShift Login') {
            steps {
                sh """
                    oc login \\
                        --token=\${OC_TOKEN} \\
                        --server=${env.OC_SERVER} \\
                        --insecure-skip-tls-verify=false
                    oc project ${params.NAMESPACE}
                    echo "✅ Logged into ${params.NAMESPACE}"
                """
            }
        }

        // ─────────────────────────────────────────────────────
        // Stage 3 — STATUS
        // ─────────────────────────────────────────────────────
        stage('Show Status') {
            when { expression { params.ACTION == 'STATUS' } }
            steps {
                script {
                    def ns = params.NAMESPACE
                    sh """
                        echo ""
                        echo "══════════════════════════════════════════════"
                        echo "  Shared Dev VM Status — ${ns}"
                        echo "══════════════════════════════════════════════"
                        echo ""
                        echo "── Deployment ────────────────────────────────"
                        oc get deployment ${env.SHARED_VM_NAME} -n ${ns} --ignore-not-found
                        echo ""
                        echo "── Pod ───────────────────────────────────────"
                        oc get pod -n ${ns} -l app=${env.SHARED_VM_NAME} -o wide
                        echo ""
                        echo "── PVC ───────────────────────────────────────"
                        oc get pvc ${env.SHARED_VM_NAME}-home -n ${ns} --ignore-not-found
                        echo ""
                        echo "── Services ──────────────────────────────────"
                        oc get svc -n ${ns} -l app=${env.SHARED_VM_NAME}
                        echo ""
                        echo "── Routes ────────────────────────────────────"
                        oc get routes -n ${ns} -l app=${env.SHARED_VM_NAME}
                        echo ""
                        echo "── ConfigMaps (users) ────────────────────────"
                        oc get configmap -n ${ns} -l app=${env.SHARED_VM_NAME}
                        echo ""
                        echo "── Developer Users ───────────────────────────"
                        oc get configmap ${env.SHARED_VM_NAME}-users -n ${ns} \\
                            -o jsonpath='{.data}' 2>/dev/null || echo "(no user registry yet)"
                        echo ""
                    """
                }
            }
        }

        // ─────────────────────────────────────────────────────
        // Stage 4 — PROVISION_VM: Clean if FORCE_RECREATE
        // ─────────────────────────────────────────────────────
        stage('Clean Existing VM') {
            when {
                allOf {
                    expression { params.ACTION == 'PROVISION_VM' }
                    expression { params.FORCE_RECREATE_VM == true }
                }
            }
            steps {
                script {
                    def ns = params.NAMESPACE
                    sh """
                        echo "⚠️  FORCE_RECREATE — removing shared VM resources (PVC preserved)..."
                        oc delete deployment  ${env.SHARED_VM_NAME}       -n ${ns} --ignore-not-found
                        oc delete service     ${env.SHARED_VM_NAME}       -n ${ns} --ignore-not-found
                        oc delete configmap   ${env.SHARED_VM_NAME}-config -n ${ns} --ignore-not-found
                        oc delete route -l app=${env.SHARED_VM_NAME}      -n ${ns} --ignore-not-found
                        echo "✅ Cleanup done — PVC and user configs preserved"
                    """
                }
            }
        }

        // ─────────────────────────────────────────────────────
        // Stage 5 — PROVISION_VM: Guard existing
        // ─────────────────────────────────────────────────────
        stage('Check Existing VM') {
            when {
                allOf {
                    expression { params.ACTION == 'PROVISION_VM' }
                    expression { params.FORCE_RECREATE_VM == false }
                }
            }
            steps {
                script {
                    def exists = sh(
                        script: "oc get deployment ${env.SHARED_VM_NAME} -n ${params.NAMESPACE} --ignore-not-found -o name",
                        returnStdout: true
                    ).trim()
                    if (exists) {
                        error """
❌ Shared VM already exists in ${params.NAMESPACE}.
   Use ACTION=ADD_DEVELOPER to add new users.
   Use FORCE_RECREATE_VM=true to rebuild the VM.
"""
                    }
                    echo "✅ No existing VM — proceeding"
                }
            }
        }

        // ─────────────────────────────────────────────────────
        // Stage 6 — PROVISION_VM: Shared PVC
        // ─────────────────────────────────────────────────────
        stage('Create Shared PVC') {
            when { expression { params.ACTION == 'PROVISION_VM' } }
            steps {
                script {
                    def ns = params.NAMESPACE
                    def pvcExists = sh(
                        script: "oc get pvc ${env.SHARED_VM_NAME}-home -n ${ns} --ignore-not-found -o name",
                        returnStdout: true
                    ).trim()

                    if (pvcExists) {
                        echo "✅ Shared PVC already exists — reusing"
                    } else {
                        sh """
cat <<EOF | oc apply -f - -n ${ns}
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: ${env.SHARED_VM_NAME}-home
  namespace: ${ns}
  labels:
    app: ${env.SHARED_VM_NAME}
    team: capital-partners
spec:
  accessModes:
    - ReadWriteOnce
  resources:
    requests:
      storage: ${params.SHARED_PVC_SIZE}
  storageClassName: thin-csi
EOF
                        echo "✅ Shared PVC created (${params.SHARED_PVC_SIZE})"
                        """
                    }
                }
            }
        }

        // ─────────────────────────────────────────────────────
        // Stage 7 — PROVISION_VM: SSH Host Keys Secret
        // ─────────────────────────────────────────────────────
        stage('Create SSH Host Keys') {
            when { expression { params.ACTION == 'PROVISION_VM' } }
            steps {
                script {
                    def ns = params.NAMESPACE
                    def secretExists = sh(
                        script: "oc get secret ${env.SHARED_VM_NAME}-ssh-hostkeys -n ${ns} --ignore-not-found -o name",
                        returnStdout: true
                    ).trim()

                    if (secretExists) {
                        echo "✅ SSH host keys already exist — reusing"
                    } else {
                        sh """
                            mkdir -p /tmp/sshkeys
                            ssh-keygen -t rsa     -b 4096 -f /tmp/sshkeys/ssh_host_rsa_key     -N ""
                            ssh-keygen -t ecdsa   -b 521  -f /tmp/sshkeys/ssh_host_ecdsa_key   -N ""
                            ssh-keygen -t ed25519        -f /tmp/sshkeys/ssh_host_ed25519_key  -N ""

                            oc create secret generic ${env.SHARED_VM_NAME}-ssh-hostkeys \\
                                --from-file=/tmp/sshkeys/ssh_host_rsa_key \\
                                --from-file=/tmp/sshkeys/ssh_host_rsa_key.pub \\
                                --from-file=/tmp/sshkeys/ssh_host_ecdsa_key \\
                                --from-file=/tmp/sshkeys/ssh_host_ecdsa_key.pub \\
                                --from-file=/tmp/sshkeys/ssh_host_ed25519_key \\
                                --from-file=/tmp/sshkeys/ssh_host_ed25519_key.pub \\
                                -n ${ns}

                            rm -rf /tmp/sshkeys
                            echo "✅ SSH host keys secret created"
                        """
                    }
                }
            }
        }

        // ─────────────────────────────────────────────────────
        // Stage 8 — PROVISION_VM: User Registry ConfigMap
        //   Tracks which developers are provisioned
        // ─────────────────────────────────────────────────────
        stage('Create User Registry') {
            when { expression { params.ACTION == 'PROVISION_VM' } }
            steps {
                script {
                    def ns = params.NAMESPACE
                    sh """
cat <<EOF | oc apply -f - -n ${ns}
apiVersion: v1
kind: ConfigMap
metadata:
  name: ${env.SHARED_VM_NAME}-users
  namespace: ${ns}
  labels:
    app: ${env.SHARED_VM_NAME}
    team: capital-partners
data:
  # Format: username: "fullname|port_offset|email"
  # Populated automatically by ADD_DEVELOPER action
  _registry_version: "1.0"
  _created_by: "jenkins-build-${env.BUILD_NUMBER}"
EOF
                    echo "✅ User registry ConfigMap created"
                    """
                }
            }
        }

        // ─────────────────────────────────────────────────────
        // Stage 9 — PROVISION_VM: Shared ConfigMap
        // ─────────────────────────────────────────────────────
        stage('Create Shared ConfigMap') {
            when { expression { params.ACTION == 'PROVISION_VM' } }
            steps {
                script {
                    def ns = params.NAMESPACE
                    sh """
cat <<EOF | oc apply -f - -n ${ns}
apiVersion: v1
kind: ConfigMap
metadata:
  name: ${env.SHARED_VM_NAME}-config
  namespace: ${ns}
  labels:
    app: ${env.SHARED_VM_NAME}
    team: capital-partners
data:
  # ── Oracle ───────────────────────────────────────
  ORACLE_HOME: "/opt/oracle/instantclient_21_13"
  LD_LIBRARY_PATH: "/opt/oracle/instantclient_21_13"
  ORACLE_HOST: "oracle-dev.bbh.com"
  ORACLE_PORT: "1521"
  ORACLE_SERVICE: "CPDW_DEV"
  # ── Airflow shared ───────────────────────────────
  AIRFLOW__CORE__EXECUTOR: "LocalExecutor"
  AIRFLOW__CORE__LOAD_EXAMPLES: "False"
  AIRFLOW__WEBSERVER__EXPOSE_CONFIG: "True"
  # ── code-server ──────────────────────────────────
  CS_DISABLE_GETTING_STARTED_OVERRIDE: "1"
EOF
                    echo "✅ Shared ConfigMap created"
                    """
                }
            }
        }

        // ─────────────────────────────────────────────────────
        // Stage 10 — PROVISION_VM: Deployment
        //   One pod with:
        //   - initContainer : setup /home structure + sshd config
        //   - container[0]  : sshd (multi-user, all devs share one sshd)
        //   - container[1]  : supervisor to manage per-user services
        // ─────────────────────────────────────────────────────
        stage('Create Shared VM Deployment') {
            when { expression { params.ACTION == 'PROVISION_VM' } }
            steps {
                script {
                    def ns  = params.NAMESPACE
                    def cpu = params.TOTAL_CPU
                    def mem = params.TOTAL_MEMORY
                    sh """
cat <<'DEPLOYMENT' | oc apply -f - -n ${ns}
apiVersion: apps/v1
kind: Deployment
metadata:
  name: ${env.SHARED_VM_NAME}
  namespace: ${ns}
  labels:
    app: ${env.SHARED_VM_NAME}
    team: capital-partners
    provisioned-by: jenkins
  annotations:
    provisioned-by-build: "${env.BUILD_URL}"
spec:
  replicas: 1
  selector:
    matchLabels:
      app: ${env.SHARED_VM_NAME}
  template:
    metadata:
      labels:
        app: ${env.SHARED_VM_NAME}
    spec:
      securityContext:
        runAsNonRoot: false
        fsGroup: 0

      # ── Init: Prepare shared filesystem ──────────────────
      initContainers:
        - name: init-shared-vm
          image: ${env.BASE_IMAGE}
          imagePullPolicy: Always
          command: ["/bin/bash", "-c"]
          args:
            - |
              set -e
              echo "==> Initialising shared VM filesystem..."

              # Shared directories
              mkdir -p /home /var/run/sshd /etc/ssh-shared /opt/dev-scripts

              # Copy SSH host keys from secret
              cp /mnt/ssh-hostkeys/ssh_host_*_key     /etc/ssh-shared/
              cp /mnt/ssh-hostkeys/ssh_host_*_key.pub /etc/ssh-shared/
              chmod 600 /etc/ssh-shared/ssh_host_*_key
              chmod 644 /etc/ssh-shared/ssh_host_*_key.pub

              # sshd_config — allows all users, each on same port 2222
              cat > /etc/ssh-shared/sshd_config <<SSHD
Port 2222
HostKey /etc/ssh-shared/ssh_host_rsa_key
HostKey /etc/ssh-shared/ssh_host_ecdsa_key
HostKey /etc/ssh-shared/ssh_host_ed25519_key
AuthorizedKeysFile      /home/%u/.ssh/authorized_keys
PasswordAuthentication  yes
ChallengeResponseAuthentication no
UsePAM                  no
X11Forwarding           no
PrintMotd               yes
AcceptEnv               LANG LC_* AIRFLOW_* DBT_* ORACLE_*
Subsystem sftp          /usr/lib/openssh/sftp-server
PidFile                 /var/run/sshd/sshd.pid
LogLevel                INFO
# Per-user environment from ~/.ssh/environment
PermitUserEnvironment   yes
SSHD

              # Supervisor config for managing per-user services
              cat > /opt/dev-scripts/start-user-services.sh <<'SCRIPT'
#!/bin/bash
# Called on login via ~/.bashrc or sshd ForceCommand
# Starts per-user Airflow + code-server if not already running

USER_HOME="/home/\$USER"
AIRFLOW_PORT=\$(cat \$USER_HOME/.dev-ports/airflow 2>/dev/null || echo 8080)
JUPYTER_PORT=\$(cat \$USER_HOME/.dev-ports/jupyter 2>/dev/null || echo 8888)
CS_PORT=\$(cat \$USER_HOME/.dev-ports/codeserver 2>/dev/null || echo 8443)

# Airflow webserver
if ! pgrep -u \$USER -f "airflow webserver" > /dev/null 2>&1; then
  export AIRFLOW_HOME=\$USER_HOME/airflow
  export AIRFLOW__DATABASE__SQL_ALCHEMY_CONN=sqlite:////\$USER_HOME/airflow/airflow.db
  nohup airflow webserver --port \$AIRFLOW_PORT > \$USER_HOME/airflow/logs/webserver.log 2>&1 &
  echo "✅ Airflow webserver started on port \$AIRFLOW_PORT"
fi

# Airflow scheduler
if ! pgrep -u \$USER -f "airflow scheduler" > /dev/null 2>&1; then
  export AIRFLOW_HOME=\$USER_HOME/airflow
  nohup airflow scheduler > \$USER_HOME/airflow/logs/scheduler.log 2>&1 &
  echo "✅ Airflow scheduler started"
fi

# JupyterLab
if ! pgrep -u \$USER -f "jupyter" > /dev/null 2>&1; then
  nohup jupyter lab \
    --ip=0.0.0.0 \
    --port=\$JUPYTER_PORT \
    --no-browser \
    --NotebookApp.token='' \
    --notebook-dir=\$USER_HOME/projects \
    > \$USER_HOME/.jupyter.log 2>&1 &
  echo "✅ JupyterLab started on port \$JUPYTER_PORT"
fi

# code-server
if ! pgrep -u \$USER -f "code-server" > /dev/null 2>&1; then
  nohup code-server \
    --bind-addr 0.0.0.0:\$CS_PORT \
    --auth none \
    --user-data-dir  \$USER_HOME/.vscode-server \
    --extensions-dir \$USER_HOME/.vscode-extensions \
    \$USER_HOME/projects \
    > \$USER_HOME/.codeserver.log 2>&1 &
  echo "✅ code-server started on port \$CS_PORT"
fi
SCRIPT
              chmod +x /opt/dev-scripts/start-user-services.sh

              echo "==> Shared VM init complete ✅"

          volumeMounts:
            - name: home
              mountPath: /home
            - name: ssh-hostkeys
              mountPath: /mnt/ssh-hostkeys
              readOnly: true
            - name: shared-scripts
              mountPath: /etc/ssh-shared
            - name: dev-scripts
              mountPath: /opt/dev-scripts
          securityContext:
            runAsUser: 0
            allowPrivilegeEscalation: true

      # ── Main Containers ───────────────────────────────────
      containers:

        # ── SSHD — single daemon, all developers connect here
        - name: sshd
          image: ${env.BASE_IMAGE}
          imagePullPolicy: Always
          command: ["/bin/bash", "-c"]
          args:
            - |
              echo "==> Starting shared sshd on port 2222..."
              exec /usr/sbin/sshd \
                  -D \
                  -f /etc/ssh-shared/sshd_config \
                  -E /proc/1/fd/1
          ports:
            - name: ssh
              containerPort: 2222
          envFrom:
            - configMapRef:
                name: ${env.SHARED_VM_NAME}-config
          env:
            - name: ORACLE_PASSWORD
              valueFrom:
                secretKeyRef:
                  name: oracle-dev-credentials
                  key: password
          volumeMounts:
            - name: home
              mountPath: /home
            - name: shared-scripts
              mountPath: /etc/ssh-shared
            - name: dev-scripts
              mountPath: /opt/dev-scripts
          resources:
            requests:
              cpu: "500m"
              memory: "512Mi"
            limits:
              cpu: "1"
              memory: "1Gi"
          readinessProbe:
            tcpSocket:
              port: 2222
            initialDelaySeconds: 15
            periodSeconds: 10
          securityContext:
            runAsUser: 0
            allowPrivilegeEscalation: true

        # ── Service Monitor — keeps per-user services running
        - name: service-monitor
          image: ${env.BASE_IMAGE}
          imagePullPolicy: Always
          command: ["/bin/bash", "-c"]
          args:
            - |
              echo "==> Service monitor running..."
              echo "    Monitors /home for active users and ensures services are up"
              while true; do
                # For each user with a home dir, check services are alive
                for user_home in /home/*/; do
                  user=\$(basename \$user_home)
                  [ "\$user" = "*" ] && continue
                  [ ! -f "\$user_home/.dev-ports/airflow" ] && continue

                  AIRFLOW_PORT=\$(cat \$user_home/.dev-ports/airflow)
                  CS_PORT=\$(cat \$user_home/.dev-ports/codeserver)
                  JUPYTER_PORT=\$(cat \$user_home/.dev-ports/jupyter)

                  # Restart Airflow webserver if down
                  if ! pgrep -u \$user -f "airflow webserver" > /dev/null 2>&1; then
                    echo "[\$(date)] Restarting Airflow webserver for \$user..."
                    su - \$user -c "
                      export AIRFLOW_HOME=\$user_home/airflow
                      export AIRFLOW__DATABASE__SQL_ALCHEMY_CONN=sqlite:////\$user_home/airflow/airflow.db
                      nohup airflow webserver --port \$AIRFLOW_PORT > \$user_home/airflow/logs/webserver.log 2>&1 &
                    "
                  fi

                  # Restart code-server if down
                  if ! pgrep -u \$user -f "code-server" > /dev/null 2>&1; then
                    echo "[\$(date)] Restarting code-server for \$user..."
                    su - \$user -c "
                      nohup code-server \
                        --bind-addr 0.0.0.0:\$CS_PORT \
                        --auth none \
                        --user-data-dir  \$user_home/.vscode-server \
                        --extensions-dir \$user_home/.vscode-extensions \
                        \$user_home/projects \
                        > \$user_home/.codeserver.log 2>&1 &
                    "
                  fi

                done
                sleep 60
              done
          envFrom:
            - configMapRef:
                name: ${env.SHARED_VM_NAME}-config
          env:
            - name: ORACLE_PASSWORD
              valueFrom:
                secretKeyRef:
                  name: oracle-dev-credentials
                  key: password
          volumeMounts:
            - name: home
              mountPath: /home
          resources:
            requests:
              cpu: "${cpu}"
              memory: "${mem}"
            limits:
              cpu: "${cpu}"
              memory: "${mem}"
          securityContext:
            runAsUser: 0
            allowPrivilegeEscalation: true

      # ── Volumes ───────────────────────────────────────────
      volumes:
        - name: home
          persistentVolumeClaim:
            claimName: ${env.SHARED_VM_NAME}-home
        - name: ssh-hostkeys
          secret:
            secretName: ${env.SHARED_VM_NAME}-ssh-hostkeys
            defaultMode: 0600
        - name: shared-scripts
          emptyDir: {}
        - name: dev-scripts
          emptyDir: {}

      restartPolicy: Always
DEPLOYMENT
                    echo "✅ Shared VM deployment created"
                    """
                }
            }
        }

        // ─────────────────────────────────────────────────────
        // Stage 11 — PROVISION_VM: Service (one port per user)
        // ─────────────────────────────────────────────────────
        stage('Create Shared Service') {
            when { expression { params.ACTION == 'PROVISION_VM' } }
            steps {
                script {
                    def ns = params.NAMESPACE
                    sh """
cat <<EOF | oc apply -f - -n ${ns}
apiVersion: v1
kind: Service
metadata:
  name: ${env.SHARED_VM_NAME}
  namespace: ${ns}
  labels:
    app: ${env.SHARED_VM_NAME}
spec:
  selector:
    app: ${env.SHARED_VM_NAME}
  type: ClusterIP
  ports:
    # ── SSH (shared, all devs use same port, different users)
    - name: ssh
      port: 2222
      targetPort: 2222
    # ── Per-user ports (offset 0-4)
    # Airflow
    - { name: airflow-0, port: 8080, targetPort: 8080 }
    - { name: airflow-1, port: 8081, targetPort: 8081 }
    - { name: airflow-2, port: 8082, targetPort: 8082 }
    - { name: airflow-3, port: 8083, targetPort: 8083 }
    - { name: airflow-4, port: 8084, targetPort: 8084 }
    # Jupyter
    - { name: jupyter-0, port: 8888, targetPort: 8888 }
    - { name: jupyter-1, port: 8889, targetPort: 8889 }
    - { name: jupyter-2, port: 8890, targetPort: 8890 }
    - { name: jupyter-3, port: 8891, targetPort: 8891 }
    - { name: jupyter-4, port: 8892, targetPort: 8892 }
    # code-server
    - { name: codeserver-0, port: 8443, targetPort: 8443 }
    - { name: codeserver-1, port: 8444, targetPort: 8444 }
    - { name: codeserver-2, port: 8445, targetPort: 8445 }
    - { name: codeserver-3, port: 8446, targetPort: 8446 }
    - { name: codeserver-4, port: 8447, targetPort: 8447 }
EOF
                    echo "✅ Shared service created"
                    """
                }
            }
        }

        // ─────────────────────────────────────────────────────
        // Stage 12 — PROVISION_VM: Wait for rollout
        // ─────────────────────────────────────────────────────
        stage('Wait for VM Ready') {
            when { expression { params.ACTION == 'PROVISION_VM' } }
            steps {
                sh """
                    echo "==> Waiting for shared VM to be ready..."
                    oc rollout status deployment/${env.SHARED_VM_NAME} \\
                        -n ${params.NAMESPACE} \\
                        --timeout=10m
                    echo "✅ Shared VM is running"
                """
            }
        }

        // ─────────────────────────────────────────────────────
        // Stage 13 — ADD_DEVELOPER
        //   - Creates Linux user inside the running pod
        //   - Sets up home dir, Airflow, dbt, code-server
        //   - Creates per-user Route
        //   - Registers in user ConfigMap
        //   - Outputs connection pack
        // ─────────────────────────────────────────────────────
        stage('Add Developer') {
            when { expression { params.ACTION == 'ADD_DEVELOPER' } }
            steps {
                script {
                    def u       = params.DEVELOPER_USERNAME
                    def name    = params.DEVELOPER_FULLNAME
                    def offset  = params.USER_PORT_OFFSET.toInteger()
                    def ns      = params.NAMESPACE
                    def domain  = env.OPENSHIFT_DOMAIN

                    // Calculate per-user ports
                    def airflowPort    = 8080 + offset
                    def jupyterPort    = 8888 + offset
                    def csPort         = 8443 + offset
                    def firstName      = name.split(' ')[0]
                    def lastName       = name.split(' ').length > 1 ? name.split(' ')[1..-1].join(' ') : 'User'

                    // Get pod name
                    def pod = sh(
                        script: "oc get pod -n ${ns} -l app=${env.SHARED_VM_NAME} -o jsonpath='{.items[0].metadata.name}'",
                        returnStdout: true
                    ).trim()

                    if (!pod) {
                        error "❌ Shared VM pod not found in ${ns}. Run ACTION=PROVISION_VM first."
                    }

                    echo "==> Adding developer ${u} to pod ${pod}..."

                    // Run user setup inside the pod
                    sh """
                        oc exec ${pod} -n ${ns} -- bash -c '

                            set -e
                            echo "==> Creating Linux user ${u}..."

                            # Create user with home dir
                            useradd -m -s /bin/bash -d /home/${u} ${u} 2>/dev/null || true
                            echo "${u}:changeme123" | chpasswd

                            # Fix ownership
                            chown -R ${u}:${u} /home/${u}

                            echo "==> Setting up home directory for ${u}..."

                            su - ${u} -c "
                                set -e

                                # Directory structure
                                mkdir -p ~/airflow/dags ~/airflow/logs ~/airflow/plugins
                                mkdir -p ~/.dbt ~/.ssh ~/projects ~/.dev-ports
                                mkdir -p ~/.config/code-server
                                mkdir -p ~/.vscode-server ~/.vscode-extensions
                                chmod 700 ~/.ssh

                                # Store per-user ports
                                echo ${airflowPort} > ~/.dev-ports/airflow
                                echo ${jupyterPort} > ~/.dev-ports/jupyter
                                echo ${csPort}      > ~/.dev-ports/codeserver

                                # SSH environment (so env vars are available via SSH)
                                cat > ~/.ssh/environment << ENV
AIRFLOW_HOME=/home/${u}/airflow
AIRFLOW__CORE__EXECUTOR=LocalExecutor
AIRFLOW__CORE__LOAD_EXAMPLES=False
AIRFLOW__DATABASE__SQL_ALCHEMY_CONN=sqlite:////home/${u}/airflow/airflow.db
DBT_PROFILES_DIR=/home/${u}/.dbt
ORACLE_SERVICE=CPDW_DEV
ORACLE_SCHEMA=${u.toUpperCase()}_DEV
ENV
                                chmod 600 ~/.ssh/environment

                                # .bashrc — auto-start services on login
                                cat >> ~/.bashrc << BASHRC

# ── BBH Dev Environment ──────────────────────────
export AIRFLOW_HOME=~/airflow
export AIRFLOW__CORE__EXECUTOR=LocalExecutor
export AIRFLOW__CORE__LOAD_EXAMPLES=False
export AIRFLOW__DATABASE__SQL_ALCHEMY_CONN=sqlite:////home/${u}/airflow/airflow.db
export DBT_PROFILES_DIR=~/.dbt
export ORACLE_SCHEMA=${u.toUpperCase()}_DEV

# Auto-start services
/opt/dev-scripts/start-user-services.sh 2>/dev/null &
# ─────────────────────────────────────────────────
BASHRC

                                # dbt profiles
                                cat > ~/.dbt/profiles.yml << DBT
cpdw:
  target: dev
  outputs:
    dev:
      type: oracle
      host: oracle-dev.bbh.com
      port: 1521
      user: ${u}
      password: \\\${ORACLE_PASSWORD}
      service: CPDW_DEV
      schema: ${u.toUpperCase()}_DEV
      threads: 4
DBT

                                # code-server config
                                cat > ~/.config/code-server/config.yaml << CS
bind-addr: 0.0.0.0:${csPort}
auth: none
cert: false
user-data-dir: /home/${u}/.vscode-server
extensions-dir: /home/${u}/.vscode-extensions
CS

                                # Airflow DB init
                                airflow db init
                                airflow users create \\
                                    --username ${u} \\
                                    --password changeme123 \\
                                    --firstname ${firstName} \\
                                    --lastname ${lastName} \\
                                    --role Admin \\
                                    --email ${u}@bbh.com

                                # Install VS Code extensions
                                code-server --install-extension ms-python.python              --extensions-dir ~/.vscode-extensions 2>/dev/null
                                code-server --install-extension innoverio.vscode-dbt-power-user --extensions-dir ~/.vscode-extensions 2>/dev/null
                                code-server --install-extension ms-toolsai.jupyter            --extensions-dir ~/.vscode-extensions 2>/dev/null
                                code-server --install-extension redhat.vscode-yaml            --extensions-dir ~/.vscode-extensions 2>/dev/null
                                code-server --install-extension eamodio.gitlens               --extensions-dir ~/.vscode-extensions 2>/dev/null
                                code-server --install-extension mechatroner.rainbow-csv       --extensions-dir ~/.vscode-extensions 2>/dev/null

                                # Start services immediately
                                /opt/dev-scripts/start-user-services.sh

                                echo Done
                            "

                            echo "✅ User ${u} created and configured"
                        '
                    """

                    // Create per-user Routes
                    sh """
cat <<EOF | oc apply -f - -n ${ns}
apiVersion: route.openshift.io/v1
kind: Route
metadata:
  name: dev-${u}-codeserver
  namespace: ${ns}
  labels:
    app: ${env.SHARED_VM_NAME}
    developer: ${u}
spec:
  host: vscode-${u}.${domain}
  to:
    kind: Service
    name: ${env.SHARED_VM_NAME}
  port:
    targetPort: codeserver-${offset}
  tls:
    termination: edge
    insecureEdgeTerminationPolicy: Redirect
---
apiVersion: route.openshift.io/v1
kind: Route
metadata:
  name: dev-${u}-airflow
  namespace: ${ns}
  labels:
    app: ${env.SHARED_VM_NAME}
    developer: ${u}
spec:
  host: airflow-${u}.${domain}
  to:
    kind: Service
    name: ${env.SHARED_VM_NAME}
  port:
    targetPort: airflow-${offset}
  tls:
    termination: edge
    insecureEdgeTerminationPolicy: Redirect
---
apiVersion: route.openshift.io/v1
kind: Route
metadata:
  name: dev-${u}-jupyter
  namespace: ${ns}
  labels:
    app: ${env.SHARED_VM_NAME}
    developer: ${u}
spec:
  host: jupyter-${u}.${domain}
  to:
    kind: Service
    name: ${env.SHARED_VM_NAME}
  port:
    targetPort: jupyter-${offset}
  tls:
    termination: edge
    insecureEdgeTerminationPolicy: Redirect
EOF
                    echo "✅ Routes created for ${u}"
                    """

                    // Register in user ConfigMap
                    sh """
                        oc patch configmap ${env.SHARED_VM_NAME}-users -n ${ns} \\
                            --type merge \\
                            -p '{"data":{"${u}":"${name}|${offset}|${u}@bbh.com|added-by-build-${env.BUILD_NUMBER}"}}'
                        echo "✅ User registered in ConfigMap"
                    """

                    // Generate connection pack
                    def sshConfig = """\
# ══════════════════════════════════════════════════════
#  BBH Dev Environment — ${u}
#  Add this to: C:\\Users\\${u}\\.ssh\\config
# ══════════════════════════════════════════════════════

Host bbh-dev
    HostName        localhost
    User            ${u}
    Port            2222
    StrictHostKeyChecking   no
    UserKnownHostsFile      NUL
    ServerAliveInterval     60
    ServerAliveCountMax     3
"""
                    def connectScript = """\
@echo off
REM ══════════════════════════════════════════════════════
REM  BBH Dev Environment — Connect ${u}
REM  Run this ONCE each morning before opening VS Code
REM ══════════════════════════════════════════════════════

echo Checking OpenShift login...
oc whoami >nul 2>&1
if errorlevel 1 (
    echo Logging in to OpenShift...
    oc login ${env.OC_SERVER} --web
)

oc project ${ns}

echo.
echo Getting pod name...
for /f "tokens=*" %%i in ('oc get pod -n ${ns} -l app=${env.SHARED_VM_NAME} -o jsonpath^={.items[0].metadata.name}') do set POD=%%i
echo Pod: %POD%

echo.
echo Starting port-forwards for ${u}...

start "SSH    :2222"             cmd /k oc port-forward pod/%POD% 2222:2222           -n ${ns}
start "Airflow:${airflowPort}"  cmd /k oc port-forward pod/%POD% ${airflowPort}:${airflowPort} -n ${ns}
start "Jupyter:${jupyterPort}"  cmd /k oc port-forward pod/%POD% ${jupyterPort}:${jupyterPort} -n ${ns}
start "VSCode :${csPort}"       cmd /k oc port-forward pod/%POD% ${csPort}:${csPort}  -n ${ns}

timeout /t 4 >nul

echo.
echo ══════════════════════════════════════════════════════
echo   Connected! Options to open VS Code:
echo.
echo   OPTION A — Desktop VS Code (Remote-SSH):
echo     Ctrl+Shift+P > Remote-SSH: Connect to Host > bbh-dev
echo     Open folder: /home/${u}/projects
echo.
echo   OPTION B — Browser (no setup needed):
echo     VS Code  -> https://vscode-${u}.${domain}
echo     Airflow  -> https://airflow-${u}.${domain}
echo     Jupyter  -> https://jupyter-${u}.${domain}
echo.
echo   Local port access (while this window is open):
echo     VS Code  -> http://localhost:${csPort}
echo     Airflow  -> http://localhost:${airflowPort}
echo     Jupyter  -> http://localhost:${jupyterPort}
echo ══════════════════════════════════════════════════════
echo.
echo Close this window to STOP all port-forwards.
pause
"""
                    def readme = """\
══════════════════════════════════════════════════════════════
  BBH Capital Partners — Developer Environment
  User     : ${u} (${name})
  VM       : Shared pod (${params.NAMESPACE})
══════════════════════════════════════════════════════════════

QUICK START
────────────────────────────────────────
OPTION A — Browser (zero install, recommended):
  VS Code  → https://vscode-${u}.${domain}
  Airflow  → https://airflow-${u}.${domain}
  Jupyter  → https://jupyter-${u}.${domain}

OPTION B — VS Code Desktop (Remote-SSH):
  1. Install extension:
     code --install-extension ms-vscode-remote.remote-ssh
  2. Copy ssh-config-${u}.txt into C:\\Users\\${u}\\.ssh\\config
  3. Run connect-${u}.bat every morning
  4. Ctrl+Shift+P → Remote-SSH: Connect to Host → bbh-dev
     Open folder: /home/${u}/projects

YOUR WORKSPACE
────────────────────────────────────────
  Projects     /home/${u}/projects/
  DAGs         /home/${u}/airflow/dags/
  dbt models   /home/${u}/.dbt/

YOUR PORTS (do not change — assigned to you)
────────────────────────────────────────
  Airflow    : ${airflowPort}
  JupyterLab : ${jupyterPort}
  VS Code    : ${csPort}
  SSH        : 2222 (shared, login with your username)

FIRST LOGIN
────────────────────────────────────────
  Airflow password : changeme123  ← change this!
  Linux password   : changeme123  ← change this!

  To change Linux password (in VS Code terminal):
  passwd

DAILY WORKFLOW
────────────────────────────────────────
  # Services start automatically on login
  # Write DAGs
  vi ~/airflow/dags/my_pipeline.py
  airflow dags test my_pipeline 2024-01-01

  # Run dbt
  cd ~/projects/cpdw
  dbt run --select staging
  dbt test

  # Git
  git checkout -b feature/my-dag
  git push origin feature/my-dag

HELP
────────────────────────────────────────
  Slack : #capital-partners-dev
  Pod   : ${pod}
  NS    : ${ns}
══════════════════════════════════════════════════════════════
"""
                    writeFile file: "ssh-config-${u}.txt",  text: sshConfig
                    writeFile file: "connect-${u}.bat",     text: connectScript
                    writeFile file: "README-${u}.txt",      text: readme

                    archiveArtifacts artifacts: "ssh-config-${u}.txt, connect-${u}.bat, README-${u}.txt"

                    echo """
╔══════════════════════════════════════════════════════════════╗
║      ✅  Developer ${u} Added Successfully                   ║
╠══════════════════════════════════════════════════════════════╣
║  BROWSER (no setup):                                         ║
║  VS Code  → https://vscode-${u}.${domain}
║  Airflow  → https://airflow-${u}.${domain}
║  Jupyter  → https://jupyter-${u}.${domain}
╠══════════════════════════════════════════════════════════════╣
║  VS Code Desktop: run connect-${u}.bat (in artifacts)        ║
║  Default password: changeme123 (must change on first login)  ║
╚══════════════════════════════════════════════════════════════╝
"""
                }
            }
        }

        // ─────────────────────────────────────────────────────
        // Stage 14 — REMOVE_DEVELOPER
        // ─────────────────────────────────────────────────────
        stage('Remove Developer') {
            when { expression { params.ACTION == 'REMOVE_DEVELOPER' } }
            steps {
                script {
                    def u  = params.DEVELOPER_USERNAME
                    def ns = params.NAMESPACE

                    def pod = sh(
                        script: "oc get pod -n ${ns} -l app=${env.SHARED_VM_NAME} -o jsonpath='{.items[0].metadata.name}'",
                        returnStdout: true
                    ).trim()

                    sh """
                        echo "==> Removing developer ${u}..."

                        # Kill user processes inside pod
                        oc exec ${pod} -n ${ns} -- bash -c '
                            pkill -u ${u} || true
                            userdel -r ${u} 2>/dev/null || true
                            echo "✅ Linux user ${u} removed"
                        '

                        # Remove routes
                        oc delete route dev-${u}-codeserver -n ${ns} --ignore-not-found
                        oc delete route dev-${u}-airflow    -n ${ns} --ignore-not-found
                        oc delete route dev-${u}-jupyter    -n ${ns} --ignore-not-found
                        echo "✅ Routes removed"

                        # Remove from user registry
                        oc patch configmap ${env.SHARED_VM_NAME}-users -n ${ns} \\
                            --type json \\
                            -p '[{"op":"remove","path":"/data/${u}"}]' 2>/dev/null || true
                        echo "✅ User removed from registry"

                        echo "⚠️  Note: /home/${u} data is preserved on PVC"
                        echo "    To permanently delete: oc exec into pod and run: rm -rf /home/${u}"
                    """
                }
            }
        }

        // ─────────────────────────────────────────────────────
        // Stage 15 — RESTART_VM
        // ─────────────────────────────────────────────────────
        stage('Restart VM') {
            when { expression { params.ACTION == 'RESTART_VM' } }
            steps {
                sh """
                    echo "==> Restarting shared VM..."
                    oc rollout restart deployment/${env.SHARED_VM_NAME} -n ${params.NAMESPACE}
                    oc rollout status  deployment/${env.SHARED_VM_NAME} -n ${params.NAMESPACE} --timeout=10m
                    echo "✅ Shared VM restarted"
                    echo "⚠️  Developers will need to re-run connect-<username>.bat"
                """
            }
        }
    }

    // ── Post ──────────────────────────────────────────────────
    post {
        success {
            echo "✅ ACTION=${params.ACTION} completed successfully"
        }
        failure {
            echo "❌ ACTION=${params.ACTION} failed — check logs above"
        }
        always {
            sh 'oc logout || true'
            cleanWs()
        }
    }
}
