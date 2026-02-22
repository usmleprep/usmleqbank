/* ============================================
   AUTH — Login / Register / Session (API-backed)
   ============================================ */
const Auth = (() => {
    const SESSION_KEY = 'usmle_session';

    function getCurrentUser() {
        try { return JSON.parse(localStorage.getItem(SESSION_KEY)); }
        catch { return null; }
    }

    function setSession(username, token) {
        localStorage.setItem(SESSION_KEY, JSON.stringify({ username, token, loginTime: Date.now() }));
    }

    function clearSession() {
        localStorage.removeItem(SESSION_KEY);
    }

    function getToken() {
        const user = getCurrentUser();
        return user ? user.token : null;
    }

    // User prefix for local cache isolation
    function getUserPrefix() {
        const user = getCurrentUser();
        return user ? `usmle_${user.username}_` : 'usmle_';
    }

    // ===== API HELPERS =====
    async function apiPost(url, body) {
        const res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Request failed');
        return data;
    }

    // ===== LOGIN =====
    async function login() {
        const username = document.getElementById('login-username').value.trim().toLowerCase();
        const password = document.getElementById('login-password').value;
        const errEl = document.getElementById('login-error');
        const btn = document.querySelector('#login-form .login-btn');

        if (!username || !password) {
            errEl.textContent = 'Please enter username and password.';
            return;
        }

        btn.disabled = true;
        btn.textContent = 'Signing in...';
        errEl.textContent = '';

        try {
            const data = await apiPost('/api/auth/login', { username, password });
            setSession(data.username, data.token);
            enterApp(data.username);
            // Load data from server after entering app
            if (typeof App !== 'undefined' && App.loadFromServer) {
                await App.loadFromServer();
            }
        } catch (err) {
            errEl.textContent = err.message;
        } finally {
            btn.disabled = false;
            btn.textContent = 'Sign In';
        }
    }

    // ===== REGISTER =====
    async function register() {
        const username = document.getElementById('reg-username').value.trim().toLowerCase();
        const password = document.getElementById('reg-password').value;
        const password2 = document.getElementById('reg-password2').value;
        const errEl = document.getElementById('register-error');
        const btn = document.querySelector('#register-form .login-btn');

        if (!username || !password) {
            errEl.textContent = 'Please fill in all fields.';
            return;
        }
        if (password !== password2) {
            errEl.textContent = 'Passwords do not match.';
            return;
        }

        btn.disabled = true;
        btn.textContent = 'Creating account...';
        errEl.textContent = '';

        try {
            const data = await apiPost('/api/auth/register', { username, password });
            setSession(data.username, data.token);
            enterApp(data.username);
        } catch (err) {
            errEl.textContent = err.message;
        } finally {
            btn.disabled = false;
            btn.textContent = 'Create Account';
        }
    }

    // ===== LOGOUT =====
    function logout() {
        clearSession();
        document.getElementById('app-container').style.display = 'none';
        document.getElementById('login-screen').style.display = 'flex';
        document.getElementById('login-username').value = '';
        document.getElementById('login-password').value = '';
        document.getElementById('login-error').textContent = '';
        showLogin();
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
        const userEl = document.getElementById('sidebar-user');
        if (userEl) {
            userEl.innerHTML = `<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z"/></svg> ${username}`;
        }
    }

    // ===== AUTO LOGIN (check saved session) =====
    function checkSession() {
        const user = getCurrentUser();
        if (user && user.username && user.token) {
            enterApp(user.username);
            return true;
        }
        document.getElementById('login-screen').style.display = 'flex';
        document.getElementById('app-container').style.display = 'none';
        return false;
    }

    // Handle Enter key
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
        getToken,
        checkSession,
    };
})();
