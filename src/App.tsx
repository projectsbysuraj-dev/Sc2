import { useState, useEffect, useCallback } from 'react';
import { ShieldAlert, XCircle, Sparkles } from 'lucide-react';
import {
  AppSettings,
  ThemeSettings,
  UserProfile,
} from './types';
import {
  getCurrentUser,
  getStoredSettings,
  getStoredTheme,
  subscribeRealtime,
  recordPendingReferral,
  syncUserWithRemote,
  saveSingleUser,
  isUserIdBlockedLocally,
} from './services/store';
import { initTelegramApp, getTelegramReferralParam, triggerHaptic } from './services/telegram';
import { Header } from './components/Header';
import { BottomNav, TabType } from './components/BottomNav';
import { HomeScreen } from './components/HomeScreen';
import { InviteScreen } from './components/InviteScreen';
import { WalletScreen } from './components/WalletScreen';
import { ProfileScreen } from './components/ProfileScreen';
import { AdminPortal } from './components/AdminPortal';
import { DeviceVerificationScreen } from './components/DeviceVerificationScreen';

function checkIsAdminRoute(): boolean {
  if (typeof window === 'undefined') return false;
  // If Telegram WebApp environment is active, never open admin route
  if (Boolean(window.Telegram?.WebApp?.initData)) return false;

  const path = window.location.pathname.toLowerCase();
  const hash = window.location.hash.toLowerCase();
  const search = new URLSearchParams(window.location.search);
  return (
    path === '/admin' ||
    path.startsWith('/admin') ||
    hash === '#/admin' ||
    hash.startsWith('#/admin') ||
    hash === '#admin' ||
    search.get('admin') === 'true' ||
    search.get('tab') === 'admin'
  );
}

export default function App() {
  const [isAdminRoute, setIsAdminRoute] = useState<boolean>(checkIsAdminRoute());
  const [activeTab, setActiveTab] = useState<TabType>('home');
  const [user, setUser] = useState<UserProfile>(getCurrentUser());
  const [settings, setSettings] = useState<AppSettings>(getStoredSettings());
  const [theme, setTheme] = useState<ThemeSettings>(getStoredTheme());
  const [isDarkMode, setIsDarkMode] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    return localStorage.getItem('rg_dark_mode_v1') === 'true';
  });

  const handleToggleDarkMode = useCallback(() => {
    setIsDarkMode((prev) => {
      const next = !prev;
      if (typeof window !== 'undefined') {
        localStorage.setItem('rg_dark_mode_v1', String(next));
      }
      return next;
    });
  }, []);
  const [showVerification, setShowVerification] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    if (checkIsAdminRoute()) return false;
    // App open hote hi direct open ho - device verification screen block nahi karega
    const search = new URLSearchParams(window.location.search);
    const hash = window.location.hash;
    const isExplicitVerify = search.get('verify') === 'true' || hash.includes('verify=true');
    return isExplicitVerify;
  });

  const handleNavigateToUserApp = useCallback(() => {
    if (typeof window !== 'undefined') {
      try {
        const cleanPath = window.location.pathname.replace(/\/admin\/?$/i, '/') || '/';
        const search = new URLSearchParams(window.location.search);
        search.delete('admin');
        search.delete('tab');
        const searchStr = search.toString() ? `?${search.toString()}` : '';
        window.history.replaceState(null, '', `${cleanPath}${searchStr}`);
        if (window.location.hash.toLowerCase().includes('admin')) {
          window.location.hash = '';
        }
      } catch {
        window.location.hash = '';
      }
    }
    setIsAdminRoute(false);
  }, []);

  const handleNavigateToAdmin = useCallback(() => {
    if (typeof window !== 'undefined') {
      window.history.pushState({}, '', '#admin');
    }
    setIsAdminRoute(true);
  }, []);

  useEffect(() => {
    initTelegramApp();
    // Synchronize user immediately after Telegram WebApp initialization
    const initialUser = getCurrentUser();
    setUser(initialUser);

    const checkAndProcessReferral = (u: UserProfile) => {
      try {
        const refParam = getTelegramReferralParam();
        if (refParam) {
          recordPendingReferral(refParam, u.id);
        }
      } catch (e) {
        console.warn('Referral check notice:', e);
      }
    };

    // Run referral check immediately
    checkAndProcessReferral(initialUser);
    if (!initialUser.deviceBlocked && initialUser.deviceVerified === true) {
      saveSingleUser(initialUser);
    }

    // Re-check after Telegram WebApp finishes injecting (250ms)
    const tgTimer = setTimeout(() => {
      const freshUser = getCurrentUser();
      setUser(freshUser);
      checkAndProcessReferral(freshUser);
      syncUserWithRemote(freshUser.id).then((fresh) => {
        if (fresh) setUser(fresh);
      });
    }, 250);

    // Initial remote profile sync
    syncUserWithRemote(initialUser.id).then((fresh) => {
      if (fresh) setUser(fresh);
    });

    // Auto-sync user balance & spins every 3.5 seconds
    const userSyncInterval = setInterval(() => {
      const current = getCurrentUser();
      syncUserWithRemote(current.id).then((fresh) => {
        if (fresh) setUser(fresh);
      });
    }, 3500);

    // 2. Listen to route / URL changes (popstate & hashchange)
    const handleUrlChange = () => {
      setIsAdminRoute(checkIsAdminRoute());
      const search = new URLSearchParams(window.location.search);
      const hash = window.location.hash;
      const isVerify = search.get('verify') === 'true' || hash.includes('verify=true');
      if (isVerify) {
        setShowVerification(true);
      }
    };
    window.addEventListener('popstate', handleUrlChange);
    window.addEventListener('hashchange', handleUrlChange);

    // 3. Subscribe to real-time events across all tabs, storage, and Firebase
    const unsubscribe = subscribeRealtime(() => {
      setUser(getCurrentUser());
      setSettings(getStoredSettings());
      setTheme(getStoredTheme());
    });

    return () => {
      clearTimeout(tgTimer);
      clearInterval(userSyncInterval);
      window.removeEventListener('popstate', handleUrlChange);
      window.removeEventListener('hashchange', handleUrlChange);
      unsubscribe();
    };
  }, []);

  const [showScratchFirstNotice, setShowScratchFirstNotice] = useState(false);

  const hasUserScratched = Boolean(
    user.balance > 0 ||
    (user.spinsEarned && user.spinsEarned > 1) ||
    (user.friendsJoined && user.friendsJoined > 0) ||
    (user.claimedWelcomeSpin && user.spins < 1) ||
    (typeof window !== 'undefined' && localStorage.getItem(`rg_has_scratched_${user.id}`) === 'true')
  );

  const handleNavigateTab = useCallback((tab: TabType) => {
    if (tab === 'invite' && !hasUserScratched) {
      triggerHaptic('medium');
      setShowScratchFirstNotice(true);
      setActiveTab('home');
      return;
    }
    setActiveTab(tab);
  }, [hasUserScratched]);

  // -------------------------------------------------------------
  // PERMANENT DEVICE BLOCKED SCREEN: Never opens again under any circumstance!
  // -------------------------------------------------------------
  const isBlocked = Boolean(
    user.deviceBlocked ||
    isUserIdBlockedLocally(user.id) ||
    isUserIdBlockedLocally(user.telegramId) ||
    (typeof window !== 'undefined' && localStorage.getItem('rg_device_blocked_forever') === 'true')
  );

  if (isBlocked && !isAdminRoute) {
    return (
      <div className="fixed inset-0 z-50 bg-[#090d16] flex flex-col justify-between p-6 text-white select-none overflow-y-auto">
        <div className="w-full max-w-sm mx-auto flex items-center justify-between pt-2">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-xl bg-rose-600/30 border border-rose-500/40 flex items-center justify-center">
              <ShieldAlert className="w-4 h-4 text-rose-400" />
            </div>
            <span className="font-['Outfit'] font-black text-sm text-white">
              {settings.appTitle || 'Scratch The Win'}
            </span>
          </div>
          <span className="text-[11px] font-bold text-rose-400 bg-rose-500/15 border border-rose-400/30 px-2.5 py-1 rounded-full">
            Permanently Blocked
          </span>
        </div>

        <div className="w-full max-w-sm mx-auto my-auto py-8">
          <div className="bg-[#0f172a] rounded-3xl p-7 border border-rose-500/60 text-center space-y-5 shadow-2xl shadow-rose-950/70">
            <div className="w-20 h-20 rounded-full bg-rose-500/20 border-2 border-rose-500/80 flex items-center justify-center mx-auto text-rose-400 shadow-xl shadow-rose-950/60">
              <XCircle className="w-12 h-12" />
            </div>

            <div className="space-y-2">
              <h2 className="font-['Outfit'] font-black text-2xl text-rose-400">
                🚫 Device Blocked!
              </h2>
              <p className="text-sm text-slate-300 font-semibold leading-relaxed">
                Ek phone me sirf 1 account allow hai. Device verification fail hone ke karan ye account permanently block kar diya gaya hai.
              </p>
              <div className="bg-rose-950/40 border border-rose-800/40 rounded-xl p-3 text-xs text-rose-300/90 font-medium">
                Ye ID ab kisi bhi tarike se dubara open nahi hogi.
              </div>
            </div>

            <button
              type="button"
              onClick={() => {
                if (typeof window !== 'undefined' && (window as any).Telegram?.WebApp?.close) {
                  (window as any).Telegram.WebApp.close();
                }
              }}
              className="w-full py-4 rounded-2xl bg-gradient-to-r from-rose-600 to-rose-700 hover:from-rose-500 hover:to-rose-600 text-white font-['Outfit'] font-black text-base shadow-xl shadow-rose-950 cursor-pointer active:scale-95 transition-all"
            >
              Close App
            </button>
          </div>
        </div>

        <div className="w-24 h-1 bg-white/20 rounded-full mx-auto" />
      </div>
    );
  }

  // -------------------------------------------------------------
  // Device Verification Screen (Matching Screenshot 3 & Anti-Switch Lock)
  // -------------------------------------------------------------
  if (showVerification) {
    return (
      <DeviceVerificationScreen
        user={user}
        settings={settings}
        referrerId={getTelegramReferralParam()}
        onContinue={() => setShowVerification(false)}
      />
    );
  }

  // -------------------------------------------------------------
  // Dedicated Admin Portal at /admin
  // -------------------------------------------------------------
  if (isAdminRoute) {
    return (
      <AdminPortal
        settings={settings}
        theme={theme}
        onNavigateToUserApp={handleNavigateToUserApp}
      />
    );
  }

  // -------------------------------------------------------------
  // User Panel: Clean Telegram Mini App (0 Admin traces)
  // -------------------------------------------------------------
  return (
    <div
      className={`min-h-screen w-full flex flex-col items-center justify-start transition-colors duration-300 overflow-x-hidden ${
        isDarkMode
          ? 'dark-mode bg-gradient-to-b from-[#090d16] via-[#0f172a] to-[#090d16] text-slate-100'
          : 'bg-gradient-to-b from-[#fbfbfa] via-[#f8f9fa] to-[#f1f3f6] text-slate-800'
      }`}
    >
      {/* Mobile Telegram App View Container */}
      <div
        className={`w-full max-w-md min-h-screen flex flex-col px-3 sm:px-4 ${
          activeTab === 'profile' ? 'pt-4' : 'pt-2'
        } pb-16 relative transition-colors duration-300 ${
          isDarkMode
            ? 'bg-transparent text-slate-100'
            : 'bg-gradient-to-b from-[#fbfbfa] via-[#f8f9fa] to-[#f1f3f6] text-slate-800'
        }`}
      >
        {/* Header (shown on Home, Invite, Wallet; hidden on Profile to match screenshot) */}
        {activeTab !== 'profile' && (
          <Header
            user={user}
            settings={settings}
            theme={theme}
            activeTab={activeTab}
            onNavigate={handleNavigateTab}
          />
        )}

        {/* Tab Views */}
        <main className={`flex-1 w-full ${activeTab === 'profile' ? 'mt-0' : 'mt-2'}`}>
          {activeTab === 'home' && (
            <HomeScreen
              user={user}
              settings={settings}
              onNavigate={handleNavigateTab}
              isDarkMode={isDarkMode}
              onToggleDarkMode={handleToggleDarkMode}
            />
          )}

          {activeTab === 'invite' && (
            <InviteScreen user={user} settings={settings} />
          )}

          {activeTab === 'wallet' && (
            <WalletScreen
              user={user}
              settings={settings}
              onNavigate={handleNavigateTab}
            />
          )}

          {activeTab === 'profile' && (
            <ProfileScreen
              user={user}
              settings={settings}
              onNavigate={handleNavigateTab}
              isDarkMode={isDarkMode}
              onToggleDarkMode={handleToggleDarkMode}
              onSecretOpenAdmin={handleNavigateToAdmin}
            />
          )}
        </main>

        {/* Floating Bottom Navigation */}
        <BottomNav
          activeTab={activeTab}
          onTabChange={handleNavigateTab}
        />

        {/* Scratch First Notice Modal */}
        {showScratchFirstNotice && (
          <div className="fixed inset-0 z-50 bg-slate-950/70 backdrop-blur-sm flex items-center justify-center p-4 animate-fade-in">
            <div className="w-full max-w-sm bg-white rounded-[28px] p-6 shadow-2xl border border-white flex flex-col items-center text-center relative animate-scale-up">
              <div className="w-16 h-16 rounded-full bg-orange-100 flex items-center justify-center text-3xl mb-3 shadow-md">
                🎁
              </div>

              <span className="text-[10px] font-black uppercase tracking-wider text-orange-600 bg-orange-50 px-3 py-1 rounded-full border border-orange-200 mb-2">
                Scratch First To Unlock
              </span>

              <h3 className="font-['Outfit'] font-black text-xl text-slate-900 tracking-tight leading-tight mb-2">
                Pehle Apna Scratch Card Khele!
              </h3>

              <p className="text-slate-600 text-xs font-semibold leading-relaxed mb-5 max-w-[260px]">
                Aapko mila hua 1 Free Scratch Card pehle scratch karein aur turant cash jeetein! Scratch karne ke baad 1 Refer = 1 Scratch unlock ho jayega!
              </p>

              <button
                type="button"
                onClick={() => {
                  triggerHaptic('light');
                  setShowScratchFirstNotice(false);
                  setActiveTab('home');
                }}
                className="w-full bg-gradient-to-r from-[#ff5e00] to-[#ff7a00] hover:from-[#e55300] hover:to-[#f06e00] text-white font-['Outfit'] font-black text-sm py-3.5 rounded-2xl shadow-lg shadow-orange-500/35 active:scale-95 transition-all flex items-center justify-center gap-2 cursor-pointer"
              >
                <Sparkles className="w-4 h-4" />
                <span>Play Free Scratch Card Now 🚀</span>
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
