/* ============================================
   AUTH — Login / Register / Session
   ============================================ */
const Auth = (() => {
    const USERS_KEY = 'usmle_users';
    const SESSION_KEY = 'usmle_session';

    function getUsers() {
        try { return JSON.parse(localStorage.getItem(USERS_KEY)) || {}; } 
        catch { return {}; }
    }
    function saveUsers(users) {
        localStorage.setItem(USERS_KEY, JSON.stringify(users));
    }

    function hashPassword(pw) {
        // Simple hash for localStorage-based auth (not cryptographic security)
        let hash = 0;
        for (let i = 0; i < pw.length; i++) {
            const chr = pw.charCodeAt(i);
            hash = ((hash << 5) - hash) + chr;
            hash |= 0;
        }
        return 'h' + Math.abs(hash).toString(36);
    }

    function getCurrentUser() {
        try { return JSON.parse(sessionStorage.getItem(SESSION_KEY) || localStorage.getItem(SESSION_KEY)); }
        catch { return null; }
    }

    function setSession(username) {
        const data = JSON.stringify({ username, loginTime: Date.now() });
        sessionStorage.setItem(SESSION_KEY, data);
        localStorage.setItem(SESSION_KEY, data);
    }

    function clearSession() {
        sessionStorage.removeItem(SESSION_KEY);
        localStorage.removeItem(SESSION_KEY);
    }

    // ===== USER PREFIX for data isolation =====
    function getUserPrefix() {
        const user = getCurrentUser();
        return user ? `usmle_${user.username}_` : 'usmle_';
    }

    // ===== LOGIN =====
    function login() {
        const username = document.getElementById('login-username').value.trim().toLowerCase();
        const password = document.getElementById('login-password').value;
        const errEl = document.getElementById('login-error');

        if (!username || !password) {
            errEl.textContent = 'Please enter username and password.';
            return;
        }

        const users = getUsers();
        if (!users[username]) {
            errEl.textContent = 'User not found. Create an account first.';
            return;
        }

        if (users[username].hash !== hashPassword(password)) {
            errEl.textContent = 'Incorrect password.';
            return;
        }

        errEl.textContent = '';
        setSession(username);
        enterApp(username);
    }

    // ===== REGISTER =====
    function register() {
        const username = document.getElementById('reg-username').value.trim().toLowerCase();
        const password = document.getElementById('reg-password').value;
        const password2 = document.getElementById('reg-password2').value;
        const errEl = document.getElementById('register-error');

        if (!username || !password) {
            errEl.textContent = 'Please fill in all fields.';
            return;
        }
        if (username.length < 3) {
            errEl.textContent = 'Username must be at least 3 characters.';
            return;
        }
        if (!/^[a-z0-9_]+$/.test(username)) {
            errEl.textContent = 'Username: only letters, numbers and underscore.';
            return;
        }
        if (password.length < 4) {
            errEl.textContent = 'Password must be at least 4 characters.';
            return;
        }
        if (password !== password2) {
            errEl.textContent = 'Passwords do not match.';
            return;
        }

        const users = getUsers();
        if (users[username]) {
            errEl.textContent = 'Username already taken.';
            return;
        }

        users[username] = { hash: hashPassword(password), created: Date.now() };
        saveUsers(users);

        errEl.textContent = '';
        setSession(username);
        enterApp(username);
    }

    // ===== LOGOUT =====
    function logout() {
        clearSession();
        document.getElementById('app-container').style.display = 'none';
        document.getElementById('login-screen').style.display = 'flex';
        // Clear form fields
        document.getElementById('login-username').value = '';
        document.getElementById('login-password').value = '';
        document.getElementById('login-error').textContent = '';
        showLogin();
        // Reload to reset App state cleanly
        location.reload();
    }

    // ===== UI SWITCH =====
    function showRegister() {
        document.getElementById('login-form').style.display = 'none';
        document.getElementById('register-form').style.display = 'block';
        document.getElementById('register-error').textContent = '';
    }
    function showLogin() {
        document.getElementById('login-form').style.display = 'block';
        document.getElementById('register-form').style.display = 'none';
        document.getElementById('login-error').textContent = '';
    }

    // ===== ENTER APP =====
    function enterApp(username) {
        document.getElementById('login-screen').style.display = 'none';
        document.getElementById('app-container').style.display = '';
        // Show username in sidebar
        const userEl = document.getElementById('sidebar-user');
        if (userEl) {
            userEl.innerHTML = `<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z"/></svg> ${username}`;
        }
    }

    // ===== AUTO LOGIN (check session on load) =====
    function checkSession() {
        const user = getCurrentUser();
        if (user && user.username) {
            const users = getUsers();
            if (users[user.username]) {
                enterApp(user.username);
                return true;
            }
        }
        // Show login screen
        document.getElementById('login-screen').style.display = 'flex';
        document.getElementById('app-container').style.display = 'none';
        return false;
    }

    // Handle Enter key on login/register forms
    document.addEventListener('DOMContentLoaded', () => {
        document.getElementById('login-password')?.addEventListener('keydown', e => {
            if (e.key === 'Enter') login();
        });
        document.getElementById('login-username')?.addEventListener('keydown', e => {
            if (e.key === 'Enter') login();
        });
        document.getElementById('reg-password2')?.addEventListener('keydown', e => {
            if (e.key === 'Enter') register();
        });
    });

    return {
        login,
        register,
        logout,
        showRegister,
        showLogin,
        getCurrentUser,
        getUserPrefix,
        checkSession,
    };
})();
