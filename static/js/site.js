(() => {
    const $ = (selector, root = document) => root.querySelector(selector);
    const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

    const api = async (path, body) => {
        const response = await fetch(`/api/${path}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
            credentials: 'same-origin',
            body: JSON.stringify(body)
        });
        const result = response.status === 204 ? {} : await response.json().catch(() => ({}));
        if (!response.ok) {
            const message = result.detail || result.message || 'Something went wrong. Please try again.';
            throw new Error(message);
        }
        return result;
    };

    const responseText = error => error instanceof Error ? error.message : 'Something went wrong. Please try again.';
    const setBusy = (button, busy, label) => {
        if (!button) return;
        if (busy) {
            button.dataset.originalText = button.textContent;
            button.disabled = true;
            button.textContent = label;
        } else {
            button.disabled = false;
            if (button.dataset.originalText) button.textContent = button.dataset.originalText;
        }
    };

    const googleButton = $('[data-google-signin]');
    const googleStatus = $('#google-login-status');
    if (googleButton) {
        const initializeGoogle = () => {
            if (!window.google?.accounts?.id || googleButton.dataset.initialized === 'true') return false;
            googleButton.dataset.initialized = 'true';
            window.google.accounts.id.initialize({
                client_id: googleButton.dataset.clientId,
                callback: async credential => {
                    if (!credential?.credential) return;
                    if (googleStatus) googleStatus.textContent = '';
                    const button = googleButton.querySelector('div[role="button"]');
                    if (button) button.setAttribute('aria-busy', 'true');
                    try {
                        await api('google-login', { credential: credential.credential });
                        window.location.assign('/account');
                    } catch (error) {
                        if (googleStatus) googleStatus.textContent = responseText(error);
                        if (button) button.removeAttribute('aria-busy');
                    }
                }
            });
            window.google.accounts.id.renderButton(googleButton, { theme: 'outline', size: 'large', shape: 'rectangular', text: 'continue_with', width: 280 });
            return true;
        };
        if (!initializeGoogle()) {
            const library = $('script[src^="https://accounts.google.com/gsi/client"]');
            library?.addEventListener('load', initializeGoogle, { once: true });
        }
    }

    $$('footer [data-year]').forEach(node => node.textContent = new Date().getFullYear());
    $$('img[data-fallback]').forEach(image => image.addEventListener('error', () => {
        image.src = image.dataset.fallback;
        image.removeAttribute('data-fallback');
    }, { once: true }));
    $$('img[data-logo-fallback]').forEach(image => image.addEventListener('error', () => {
        image.hidden = true;
        const fallback = image.nextElementSibling;
        if (fallback) fallback.hidden = false;
    }, { once: true }));

    $$('.map-point').forEach(point => {
        const x = Number.parseFloat(point.style.getPropertyValue('--x'));
        if (x > 50) point.classList.add('tooltip-left');
        point.addEventListener('pointerenter', () => point.classList.add('is-active'));
        point.addEventListener('pointerleave', () => {
            if (document.activeElement !== point && !point.classList.contains('is-selected')) point.classList.remove('is-active');
        });
        point.addEventListener('focus', () => point.classList.add('is-active'));
        point.addEventListener('blur', () => {
            if (!point.classList.contains('is-selected')) point.classList.remove('is-active');
        });
        point.addEventListener('click', () => {
            $$('.map-point.is-selected').forEach(active => active.classList.remove('is-selected', 'is-active'));
            point.classList.add('is-selected', 'is-active');
        });
    });

    const menuButton = $('.menu-toggle');
    const mainNav = $('.main-nav');
    if (menuButton && mainNav) {
        menuButton.addEventListener('click', () => {
            const expanded = menuButton.getAttribute('aria-expanded') === 'true';
            menuButton.setAttribute('aria-expanded', String(!expanded));
            mainNav.classList.toggle('open', !expanded);
        });
        mainNav.addEventListener('click', event => {
            if (event.target.closest('a')) {
                menuButton.setAttribute('aria-expanded', 'false');
                mainNav.classList.remove('open');
            }
        });
    }

    const chatPanel = $('#chat-panel');
    const chatLauncher = $('#chat-launcher');
    const chatForm = $('#chat-form');
    const chatMessages = $('#chat-messages');
    if (chatPanel && chatLauncher && chatForm && chatMessages) {
        const chatStorageKey = 'unipath-chat-session-v1';
        let conversationId = localStorage.getItem(chatStorageKey);
        if (!/^[0-9a-f-]{36}$/i.test(conversationId || '')) {
            conversationId = crypto.randomUUID ? crypto.randomUUID() : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, value => { const random = Math.random() * 16 | 0; return (value === 'x' ? random : (random & 3 | 8)).toString(16); });
            localStorage.setItem(chatStorageKey, conversationId);
        }
        const addChatMessage = (text, role) => {
            const bubble = document.createElement('p');
            bubble.className = `chat-message ${role}-message`;
            bubble.textContent = text;
            chatMessages.append(bubble);
            chatMessages.scrollTop = chatMessages.scrollHeight;
            return bubble;
        };
        const loadChatHistory = async () => {
            try {
                const response = await fetch(`/api/chat?conversationId=${encodeURIComponent(conversationId)}`, { credentials: 'same-origin' });
                if (!response.ok) return;
                const history = await response.json();
                if (history.length) {
                    chatMessages.replaceChildren();
                    history.forEach(entry => addChatMessage(entry.message, entry.sender === 'student' ? 'user' : 'assistant'));
                }
            } catch { /* Keep the welcome message visible while offline. */ }
        };
        loadChatHistory();
        window.setInterval(() => { if (!chatPanel.hidden) loadChatHistory(); }, 5000);
        const toggleChat = open => {
            chatPanel.hidden = !open;
            chatLauncher.setAttribute('aria-expanded', String(open));
            if (open) $('#chat-input').focus();
        };
        document.addEventListener('click', event => {
            if (event.target.closest('#chat-launcher')) toggleChat(chatPanel.hidden);
        });
        $('#chat-close')?.addEventListener('click', () => toggleChat(false));
        chatForm.addEventListener('submit', async event => {
            event.preventDefault();
            const input = $('#chat-input');
            const question = input.value.trim();
            if (!question) return;
            addChatMessage(question, 'user');
            input.value = '';
            const send = $('button[type="submit"]', chatForm);
            setBusy(send, true, '…');
            const waiting = addMessage('Let me think…', 'assistant');
            let assistantAnswer = '';
            try {
                const response = await api('chat', { message: question, conversationId });
                assistantAnswer = response.answer;
                waiting.textContent = assistantAnswer;
            } catch (error) {
                waiting.textContent = responseText(error);
            }
            try { await loadChatHistory(); } finally {
                setBusy(send, false);
                input.focus();
            }
        });
    }

    const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    const bindAccountForm = (formId, endpoint, successPath, busyText) => {
        const form = $(`#${formId}`);
        if (!form) return;
        const status = $('.form-response', form);
        form.addEventListener('submit', async event => {
            event.preventDefault();
            status.className = 'form-response';
            status.textContent = '';
            const values = Object.fromEntries(new FormData(form));
            values.email = (values.email || '').trim().toLowerCase();
            if (!emailPattern.test(values.email)) {
                status.textContent = 'Enter a valid email address to continue.';
                return;
            }
            const button = $('button[type="submit"]', form);
            setBusy(button, true, busyText);
            try {
                await api(endpoint, values);
                window.location.assign(successPath);
            } catch (error) {
                status.textContent = responseText(error);
            } finally {
                setBusy(button, false);
            }
        });
    };

    bindAccountForm('register-form', 'register', '/account', 'Creating your account…');
    bindAccountForm('login-form', 'login', '/account', 'Signing you in…');

    const forgotPasswordForm = $('#forgot-password-form');
    if (forgotPasswordForm) {
        const status = $('.form-response', forgotPasswordForm);
        forgotPasswordForm.addEventListener('submit', async event => {
            event.preventDefault(); status.textContent = '';
            const button = $('button[type="submit"]', forgotPasswordForm); setBusy(button, true, 'Sending…');
            try { const result = await api('password-reset/request', { email: forgotPasswordForm.elements.email.value.trim() }); status.textContent = result.message; status.classList.add('success'); }
            catch (error) { status.textContent = responseText(error); status.classList.remove('success'); }
            finally { setBusy(button, false); }
        });
    }
    const resetPasswordForm = $('#reset-password-form');
    if (resetPasswordForm) {
        const status = $('.form-response', resetPasswordForm);
        resetPasswordForm.addEventListener('submit', async event => {
            event.preventDefault(); status.textContent = '';
            const button = $('button[type="submit"]', resetPasswordForm); setBusy(button, true, 'Saving…');
            try { const result = await api('password-reset/confirm', { token: resetPasswordForm.elements.token.value, password: resetPasswordForm.elements.password.value }); status.textContent = result.message; status.classList.add('success'); resetPasswordForm.elements.password.value = ''; window.setTimeout(() => window.location.assign('/login?reset=success'), 1500); }
            catch (error) { status.textContent = responseText(error); status.classList.remove('success'); }
            finally { setBusy(button, false); }
        });
    }

    const adminForm = $('#admin-login-form');
    const adminDashboard = $('#admin-dashboard');
    const showAdminDashboard = async () => {
        const response = await fetch('/api/admin/dashboard', { credentials: 'same-origin', headers: { 'Accept': 'application/json' } });
        if (!response.ok) return false;
        const data = await response.json();
        $('#admin-login-card').hidden = true;
        adminDashboard.hidden = false;
        const stats = $('#admin-stats');
        stats.replaceChildren();
        [['Accounts', data.users], ['Saved universities', data.savedUniversities], ['Inbox messages', data.inquiries], ['Replies sent', data.replies]].forEach(([label, amount]) => {
            const item = document.createElement('article');
            const figure = document.createElement('strong');
            figure.textContent = amount;
            const caption = document.createElement('span');
            caption.textContent = label;
            item.append(figure, caption);
            stats.append(item);
        });
        const inquiryList = $('#admin-inquiries');
        const usersTable = $('#admin-users');
        usersTable?.replaceChildren();
        (data.usersList || []).forEach(user => {
            const row = document.createElement('tr');
            const student = document.createElement('td');
            student.innerHTML = `<strong></strong><br><span></span>`;
            student.querySelector('strong').textContent = user.name || 'Student';
            student.querySelector('span').textContent = user.email || '';
            const goals = document.createElement('td');
            goals.textContent = [user.target_country, user.intended_degree, user.subject_area, user.target_intake, user.annual_budget ? `Budget ${user.annual_budget}` : ''].filter(Boolean).join(' · ') || 'Study goals not added';
            const saved = document.createElement('td'); saved.textContent = user.favorites ?? 0;
            const joined = document.createElement('td'); joined.textContent = user.created_at ? new Date(user.created_at).toLocaleDateString() : '';
            row.append(student, goals, saved, joined); usersTable?.append(row);
        });
        const chatList = $('#admin-chats');
        if (chatList) {
            chatList.replaceChildren();
            const threads = data.chatThreads || [];
            if (!threads.length) { chatList.textContent = 'No chat conversations yet.'; }
            threads.forEach(thread => {
                const card = document.createElement('article'); card.className = 'admin-inquiry admin-chat-thread';
                const title = document.createElement('h3'); title.textContent = 'Website chat';
                const meta = document.createElement('time'); meta.textContent = `${thread.created_at ? new Date(thread.created_at).toLocaleString() : ''} · ${thread.student_messages || 0} student message(s)`;
                const preview = document.createElement('p'); preview.textContent = thread.preview || thread.latest || 'New conversation';
                const history = document.createElement('div'); history.className = 'admin-chat-history';
                const form = document.createElement('form'); form.className = 'admin-reply';
                const input = document.createElement('textarea'); input.required = true; input.maxLength = 3000; input.placeholder = 'Reply in the visitor’s chat…';
                const status = document.createElement('p'); status.className = 'admin-reply-status';
                const submit = document.createElement('button'); submit.className = 'button button-small'; submit.type = 'submit'; submit.textContent = 'Reply in chat';
                form.append(input, submit, status);
                const loadHistory = async () => {
                    const response = await fetch(`/api/admin/chat?conversationId=${encodeURIComponent(thread.id)}`, { credentials: 'same-origin' });
                    if (!response.ok) return;
                    history.replaceChildren();
                    (await response.json()).forEach(entry => { const line = document.createElement('p'); line.className = `chat-message ${entry.sender === 'student' ? 'user-message' : 'assistant-message'}`; line.textContent = `${entry.sender === 'team' ? 'UniPath team' : entry.sender === 'student' ? 'Student' : 'Assistant'}: ${entry.message}`; history.append(line); });
                };
                form.addEventListener('submit', async event => { event.preventDefault(); setBusy(submit, true, 'Sending…'); try { await api('admin/chat/reply', { conversationId: thread.id, message: input.value.trim() }); input.value = ''; status.textContent = 'Reply added. It will appear in the visitor’s chat.'; await loadHistory(); } catch (error) { status.textContent = responseText(error); } finally { setBusy(submit, false); } });
                card.append(title, meta, preview, history, form); chatList.append(card); loadHistory().catch(() => {});
            });
        }
        inquiryList.replaceChildren();
        if (!data.recentInquiries.length) {
            inquiryList.textContent = 'No messages have arrived yet.';
            return true;
        }
        data.recentInquiries.forEach(entry => {
            // H2 may return uppercase map keys; normalize them before rendering.
            const messageData = {
                id: entry.id ?? entry.ID,
                name: entry.name ?? entry.NAME ?? 'Website visitor',
                email: entry.email ?? entry.EMAIL ?? '',
                subject: entry.subject ?? entry.SUBJECT ?? 'Website message',
                message: entry.message ?? entry.MESSAGE ?? 'No message text was provided.',
                createdAt: entry.created_at ?? entry.CREATED_AT,
                latestReply: entry.latest_reply ?? entry.LATEST_REPLY
            };
            const card = document.createElement('article');
            card.className = 'admin-inquiry';
            const heading = document.createElement('h3');
            heading.textContent = messageData.subject;
            const contact = document.createElement('p');
            const isChatConversation = messageData.subject === 'Website chat conversation';
            contact.textContent = isChatConversation
                ? `${messageData.name} · Website chat · no reply address supplied`
                : `${messageData.name}${messageData.email ? ` · ${messageData.email}` : ''}`;
            const message = document.createElement('p');
            message.textContent = messageData.message;
            const received = document.createElement('time');
            received.textContent = messageData.createdAt ? new Date(messageData.createdAt).toLocaleString() : '';
            card.append(heading, contact, message, received);
            if (messageData.latestReply) {
                const previousReply = document.createElement('p');
                previousReply.className = 'admin-previous-reply';
                previousReply.textContent = `Latest reply: ${messageData.latestReply}`;
                card.append(previousReply);
            }
            if (!isChatConversation) {
            const replyForm = document.createElement('form');
            replyForm.className = 'admin-reply';
            const replyLabel = document.createElement('label');
            replyLabel.textContent = `Reply to ${messageData.email || 'this visitor'}`;
            const replyInput = document.createElement('textarea');
            replyInput.name = 'message';
            replyInput.required = true;
            replyInput.maxLength = 3000;
            replyInput.placeholder = 'Write a reply to this enquiry…';
            const replyStatus = document.createElement('p');
            replyStatus.className = 'admin-reply-status';
            replyStatus.setAttribute('role', 'status');
            const replyActions = document.createElement('div');
            replyActions.className = 'admin-reply-actions';
            const sendReply = document.createElement('button');
            sendReply.className = 'button button-small';
            sendReply.type = 'submit';
            sendReply.textContent = 'Send reply';
            const manualReply = document.createElement('a');
            manualReply.className = 'text-link';
            manualReply.href = `mailto:${messageData.email}?subject=${encodeURIComponent(`Re: ${messageData.subject}`)}`;
            manualReply.textContent = 'Open email app';
            replyActions.append(sendReply, manualReply);
            replyLabel.append(replyInput);
            replyForm.append(replyLabel, replyActions, replyStatus);
            replyForm.addEventListener('submit', async event => {
                event.preventDefault();
                if (!replyInput.value.trim()) return;
                setBusy(sendReply, true, 'Sending…');
                replyStatus.textContent = '';
                try {
                    const result = await api('admin/reply', { messageId: messageData.id, message: replyInput.value.trim() });
                    replyStatus.textContent = result.message;
                    replyStatus.classList.add('success');
                    replyInput.value = '';
                    await showAdminDashboard();
                } catch (error) {
                    replyStatus.textContent = responseText(error);
                    replyStatus.classList.remove('success');
                } finally { setBusy(sendReply, false); }
            });
            card.append(replyForm);
            }
            inquiryList.append(card);
        });
        return true;
    };
    if (adminDashboard) showAdminDashboard().catch(() => {});
    adminForm?.addEventListener('submit', async event => {
        event.preventDefault();
        const status = $('#admin-login-status');
        status.textContent = '';
        const button = $('button[type="submit"]', adminForm);
        setBusy(button, true, 'Signing in…');
        try {
            await api('admin/login', { password: new FormData(adminForm).get('password') });
            await showAdminDashboard();
        } catch (error) {
            status.textContent = responseText(error);
        } finally { setBusy(button, false); }
    });
    $('#admin-logout')?.addEventListener('click', async () => {
        await api('admin/logout', {});
        window.location.reload();
    });

    const accountName = $('[data-account-name]');
    const profileForm = $('#profile-form');
    const planList = $('#account-plan-list');
    const accountFavorites = $('#account-favorite-list');
    if (accountName || planList) {
        fetch('/api/me', { credentials: 'same-origin', headers: { 'Accept': 'application/json' } })
            .then(async response => {
                if (!response.ok) {
                    window.location.replace('/login?next=account');
                    return null;
                }
                return response.json();
            })
            .then(account => {
                if (!account) return;
                if (accountName) accountName.textContent = account.name;
                if (profileForm) {
                    const nameParts = (account.name || '').trim().split(/\s+/);
                    profileForm.elements.firstName.value = nameParts.shift() || '';
                    profileForm.elements.lastName.value = nameParts.join(' ');
                    $('[data-account-email]', profileForm).value = account.email || '';
                    const goals = account.goals || {};
                    const goalFields = { target_country: 'targetCountry', intended_degree: 'intendedDegree', subject_area: 'subjectArea', target_intake: 'targetIntake', annual_budget: 'annualBudget' };
                    Object.entries(goalFields).forEach(([key, field]) => { profileForm.elements[field].value = goals[key] ?? goals[key.toUpperCase()] ?? ''; });
                }
                const goalValues = Object.values(account.goals || {}).filter(value => typeof value === 'string' && value.trim());
                const nextStep = $('[data-account-next-step]');
                const planSummary = $('[data-account-plan-summary]');
                if (nextStep && goalValues.length) nextStep.textContent = `Explore ${goalValues[0]} study options`;
                if (planSummary && goalValues.length) planSummary.textContent = goalValues.join(' · ');
                const requestCount = $('[data-account-requests-count]');
                if (requestCount) requestCount.textContent = (account.subscriptions || []).length;
                const savedCount = $('[data-account-favorites-count]');
                if (savedCount) savedCount.textContent = account.favoritesCount ?? 0;
                if (planList) {
                    const subscriptions = account.subscriptions || [];
                    planList.replaceChildren();
                    if (subscriptions.length === 0) {
                        const message = document.createElement('p');
                        message.className = 'muted';
                        message.textContent = 'You’re on Explore. Save an interesting option and build your shortlist.';
                        planList.append(message);
                    } else {
                        subscriptions.forEach(subscription => {
                            const line = document.createElement('div');
                            line.className = 'account-plan-item';
                            const name = document.createElement('strong');
                            const planNames = { starter: 'University Shortlist', application: 'Application Guidance', essay: 'Essay & Motivation Letter', full: 'Full Admissions Support' };
                            name.textContent = planNames[subscription.plan] || 'UniPath guidance request';
                            const status = document.createElement('span');
                            status.textContent = 'Demo · no billing';
                            line.append(name, status);
                            planList.append(line);
                        });
                    }
                }
                if (accountFavorites) {
                    fetch('/api/favorites', { credentials: 'same-origin', headers: { 'Accept': 'application/json' } })
                        .then(response => response.ok ? response.json() : Promise.reject(new Error('Could not load your saved universities.')))
                        .then(favorites => {
                            accountFavorites.replaceChildren();
                            if (!favorites.length) {
                                const message = document.createElement('p');
                                message.className = 'muted';
                                message.textContent = 'Your shortlist is still open. Save a university to keep it close.';
                                accountFavorites.append(message);
                                return;
                            }
                            favorites.forEach(favorite => {
                                const row = document.createElement('div');
                                row.className = 'account-favorite-item';
                                const name = document.createElement('a');
                                name.href = `/universities#${encodeURIComponent(favorite.slug)}`;
                                name.textContent = favorite.name;
                                const remove = document.createElement('button');
                                remove.type = 'button';
                                remove.className = 'favorite-remove';
                                remove.textContent = 'Remove';
                                remove.addEventListener('click', async () => {
                                    remove.disabled = true;
                                    try {
                                        await api('favorites', { slug: favorite.slug, action: 'remove' });
                                        row.remove();
                                        const savedCount = $('[data-account-favorites-count]');
                                        if (savedCount) savedCount.textContent = Math.max(0, Number(savedCount.textContent) - 1);
                                        if (!accountFavorites.children.length) {
                                            const message = document.createElement('p');
                                            message.className = 'muted';
                                            message.textContent = 'Your shortlist is still open. Save a university to keep it close.';
                                            accountFavorites.append(message);
                                        }
                                    } catch (error) {
                                        remove.disabled = false;
                                        remove.textContent = responseText(error);
                                    }
                                });
                                row.append(name, remove);
                                accountFavorites.append(row);
                            });
                        }).catch(error => {
                            accountFavorites.textContent = responseText(error);
                        });
                }
            }).catch(() => {
                if (planList) planList.innerHTML = '<p>We couldn’t load your account. Refresh the page to try again.</p>';
            });
    }

    if (profileForm) {
        const status = $('.form-response', profileForm);
        profileForm.addEventListener('submit', async event => {
            event.preventDefault();
            status.textContent = '';
            const button = $('button[type="submit"]', profileForm);
            setBusy(button, true, 'Saving…');
            try {
                const result = await api('profile', Object.fromEntries(new FormData(profileForm)));
                if (accountName) accountName.textContent = result.name;
                status.classList.add('success');
                status.textContent = 'Your profile is saved.';
            } catch (error) {
                status.textContent = responseText(error);
            } finally {
                setBusy(button, false);
            }
        });
    }

    const logoutButton = $('#logout-button');
    if (logoutButton) logoutButton.addEventListener('click', async () => {
        logoutButton.disabled = true;
        try {
            await api('logout', {});
            window.location.assign('/');
        } catch (error) {
            logoutButton.disabled = false;
            logoutButton.textContent = responseText(error);
        }
    });

    const contactForm = $('#contact-form');
    if (contactForm) {
        const status = $('.form-response', contactForm);
        contactForm.addEventListener('submit', async event => {
            event.preventDefault();
            status.className = 'form-response';
            status.textContent = '';
            const button = $('button[type="submit"]', contactForm);
            setBusy(button, true, 'Sending your note…');
            try {
                const result = await api('contact', Object.fromEntries(new FormData(contactForm)));
                status.classList.add('success');
                status.textContent = result.message;
                contactForm.reset();
            } catch (error) {
                status.textContent = responseText(error);
            } finally {
                setBusy(button, false);
            }
        });
    }

    const directoryForm = $('#directory-filter-form');
    $('#uni-sort')?.addEventListener('change', () => directoryForm?.requestSubmit());
    $('#reset-filters')?.addEventListener('click', () => window.location.assign('/universities'));

    const bookingForm = $('#booking-form');
    if (bookingForm) {
        const params = new URLSearchParams(window.location.search);
        const plans = { starter: ['University Shortlist', 49], application: ['Application Guidance', 149], essay: ['Essay & Motivation Letter', 89], full: ['Full Admissions Support', 399] };
        const chosen = plans[params.get('plan')] ? params.get('plan') : 'application';
        $('#checkout-plan-title').textContent = plans[chosen][0];
        let validPromo = '';
        const updatePrice = () => {
            const rate = validPromo === 'STUDY10' ? 0.10 : validPromo === 'UNIPATH15' ? 0.15 : 0;
            const finalPrice = Math.round(plans[chosen][1] * (1 - rate));
            $('#checkout-price').textContent = rate ? `$${finalPrice} (${Math.round(rate * 100)}% off)` : `$${plans[chosen][1]}`;
        };
        updatePrice();
        $('#apply-promo')?.addEventListener('click', () => {
            const codeInput = $('input[name="promoCode"]', bookingForm);
            const code = codeInput.value.trim().toUpperCase();
            const promoStatus = $('#promo-status');
            if (['STUDY10', 'UNIPATH15'].includes(code)) {
                validPromo = code;
                promoStatus.textContent = `${code} applied. This discount will be confirmed by the UniPath team.`;
                promoStatus.className = 'promo-response success';
            } else {
                validPromo = '';
                promoStatus.textContent = code ? 'That code is not valid. Try STUDY10 or UNIPATH15.' : 'Enter a promo code first.';
                promoStatus.className = 'promo-response';
            }
            updatePrice();
        });
        const cardInput = $('input[name="cardNumber"]', bookingForm);
        cardInput.addEventListener('input', () => {
            const digits = cardInput.value.replace(/\D/g, '').slice(0, 19);
            cardInput.value = digits.replace(/(.{4})/g, '$1 ').trim();
        });
        const expiryInput = $('input[name="expiry"]', bookingForm);
        expiryInput.addEventListener('input', () => {
            const digits = expiryInput.value.replace(/\D/g, '').slice(0, 4);
            expiryInput.value = digits.length > 2 ? `${digits.slice(0, 2)} / ${digits.slice(2)}` : digits;
        });
        $('input[name="cvc"]', bookingForm).addEventListener('input', event => { event.target.value = event.target.value.replace(/\D/g, '').slice(0, 4); });
        bookingForm.addEventListener('submit', async event => {
            event.preventDefault();
            const status = $('#booking-status');
            status.textContent = '';
            if (!bookingForm.reportValidity()) return;
            const values = new FormData(bookingForm);
            const digits = String(values.get('cardNumber')).replace(/\D/g, '');
            let sum = 0;
            let doubleDigit = false;
            for (let index = digits.length - 1; index >= 0; index -= 1) {
                let digit = Number(digits[index]);
                if (doubleDigit) { digit *= 2; if (digit > 9) digit -= 9; }
                sum += digit;
                doubleDigit = !doubleDigit;
            }
            const expiryDigits = String(values.get('expiry')).replace(/\D/g, '');
            const month = Number(expiryDigits.slice(0, 2));
            const year = Number(`20${expiryDigits.slice(2, 4)}`);
            const now = new Date();
            const card = $('input[name="cardNumber"]', bookingForm);
            const expiry = $('input[name="expiry"]', bookingForm);
            const cvc = $('input[name="cvc"]', bookingForm);
            if (digits.length < 12 || digits.length > 19 || sum % 10 !== 0) {
                card.setCustomValidity('Enter a valid card number. For a demo, use 4242 4242 4242 4242.');
                card.reportValidity();
                card.setCustomValidity('');
                return;
            }
            if (expiryDigits.length !== 4 || month < 1 || month > 12 || year < now.getFullYear() || (year === now.getFullYear() && month < now.getMonth() + 1)) {
                expiry.setCustomValidity('Enter a valid future expiry date.');
                expiry.reportValidity();
                expiry.setCustomValidity('');
                return;
            }
            if (!/^\d{3,4}$/.test(String(values.get('cvc')))) {
                cvc.setCustomValidity('Enter the 3 or 4 digit security code.');
                cvc.reportValidity();
                cvc.setCustomValidity('');
                return;
            }
            const submit = $('button[type="submit"]', bookingForm);
            setBusy(submit, true, 'Saving your request…');
            try {
                const result = await api('purchase', { plan: chosen, name: `${values.get('firstName').trim()} ${values.get('lastName').trim()}`.trim(), email: values.get('email').trim(), destination: values.get('destination'), promoCode: validPromo });
                bookingForm.hidden = true;
                $('#booking-success').hidden = false;
                $('[data-booking-message]').textContent = result.message;
            } catch (error) {
                status.textContent = responseText(error);
            } finally { setBusy(submit, false); }
        });
    }

    const favoriteButtons = $$('.favorite-button');
    const signedIn = $('.nav-actions a[href="/account"]') !== null;
    if (favoriteButtons.length) {
        const setFavoriteButtons = (slug, saved) => {
            favoriteButtons.filter(button => button.dataset.favorite === slug).forEach(button => {
                button.setAttribute('aria-pressed', String(saved));
                button.classList.toggle('is-saved', saved);
                button.textContent = saved ? '♥ Saved' : '♡ Save university';
            });
        };
        if (signedIn) {
            fetch('/api/favorites', { credentials: 'same-origin', headers: { 'Accept': 'application/json' } })
                .then(response => response.ok ? response.json() : [])
                .then(favorites => favorites.forEach(favorite => {
                    setFavoriteButtons(favorite.slug, true);
                })).catch(() => {});
        }

        favoriteButtons.forEach(button => button.addEventListener('click', async () => {
            const status = $('#favorite-status');
            const currentlySaved = button.getAttribute('aria-pressed') === 'true';
            button.disabled = true;
            if (status) { status.replaceChildren(); status.textContent = ''; }
            try {
                const result = await api('favorites', { slug: button.dataset.favorite, action: currentlySaved ? 'remove' : 'save' });
                setFavoriteButtons(button.dataset.favorite, result.saved);
                if (status) {
                    status.classList.add('success');
                    status.textContent = result.saved ? `${result.name} is saved. ` : `${result.name} was removed from your shortlist.`;
                    if (result.saved) {
                        const savedLink = document.createElement('a');
                        savedLink.href = '/account#saved-universities';
                        savedLink.textContent = 'View favourites';
                        status.append(savedLink);
                    }
                }
            } catch (error) {
                if (error.message.toLowerCase().includes('sign in')) {
                    if (status) {
                        status.textContent = 'Sign in to save your shortlist. ';
                        const loginLink = document.createElement('a');
                        loginLink.href = '/login?next=universities';
                        loginLink.textContent = 'Log in';
                        status.append(loginLink);
                    }
                } else if (status) status.textContent = responseText(error);
            } finally {
                button.disabled = false;
            }
        }));
    }

    const savedUniversities = $('#saved-universities');
    if (savedUniversities) {
        fetch('/api/favorites', { credentials: 'same-origin', headers: { 'Accept': 'application/json' } })
            .then(async response => {
                if (response.status === 401) throw new Error('Sign in to see your saved universities.');
                if (!response.ok) throw new Error('Your shortlist could not be loaded. Please try again.');
                return response.json();
            })
            .then(favorites => {
                savedUniversities.replaceChildren();
                const uniqueFavorites = [...new Map(favorites.map(favorite => [favorite.slug, favorite])).values()];
                if (!uniqueFavorites.length) {
                    const empty = document.createElement('div');
                    empty.className = 'saved-empty';
                    empty.innerHTML = '<h2>Your shortlist is ready.</h2><p>Explore the program finder and save universities that interest you.</p><a class="button" href="/universities">Explore universities →</a>';
                    savedUniversities.append(empty);
                    return;
                }
                uniqueFavorites.forEach(favorite => {
                    const card = document.createElement('article');
                    card.className = 'saved-university-card';
                    const badge = document.createElement('span');
                    badge.className = 'saved-university-badge';
                    badge.textContent = favorite.name.slice(0, 1);
                    const title = document.createElement('h2');
                    title.textContent = favorite.name;
                    const searchLink = document.createElement('a');
                    searchLink.href = `/universities?q=${encodeURIComponent(favorite.name)}`;
                    searchLink.textContent = 'Find programs →';
                    const remove = document.createElement('button');
                    remove.type = 'button';
                    remove.className = 'favorite-remove';
                    remove.textContent = 'Remove from shortlist';
                    remove.addEventListener('click', async () => {
                        remove.disabled = true;
                        try {
                            await api('favorites', { slug: favorite.slug, action: 'remove' });
                            card.remove();
                            if (!savedUniversities.children.length) {
                                const empty = document.createElement('div');
                                empty.className = 'saved-empty';
                                const heading = document.createElement('h2');
                                heading.textContent = 'Your shortlist is ready.';
                                const link = document.createElement('a');
                                link.href = '/universities';
                                link.className = 'button';
                                link.textContent = 'Explore universities →';
                                empty.append(heading, link);
                                savedUniversities.append(empty);
                            }
                        } catch (error) {
                            $('#favorites-message').textContent = responseText(error);
                            remove.disabled = false;
                        }
                    });
                    card.append(badge, title, searchLink, remove);
                    savedUniversities.append(card);
                });
            })
            .catch(error => {
                savedUniversities.replaceChildren();
                const message = $('#favorites-message');
                message.textContent = `${responseText(error)} `;
                const signIn = document.createElement('a');
                signIn.href = '/login?next=favorites';
                signIn.textContent = 'Log in';
                message.append(signIn);
            });
    }

    const dialog = $('#checkout-dialog');
    const checkoutForm = $('#checkout-form');
    const checkoutSuccess = $('.checkout-success', dialog || document);
    if (dialog && checkoutForm) {
        $$('[data-checkout]').forEach(button => button.addEventListener('click', () => {
            const plan = button.dataset.checkout;
            const hiddenPlan = $('input[name="plan"]', checkoutForm);
            hiddenPlan.value = plan;
            const submit = $('button[type="submit"]', checkoutForm);
            submit.innerHTML = plan === 'plus' ? 'Continue — $9 demo <span>↗</span>' : 'Continue — $19 demo <span>↗</span>';
            checkoutForm.hidden = false;
            checkoutSuccess.hidden = true;
            dialog.showModal();
            document.body.classList.add('dialog-open');
        }));
        const closeDialog = () => {
            dialog.close();
            document.body.classList.remove('dialog-open');
        };
        $('.dialog-close', dialog)?.addEventListener('click', closeDialog);
        dialog.addEventListener('click', event => { if (event.target === dialog) closeDialog(); });
        dialog.addEventListener('close', () => document.body.classList.remove('dialog-open'));

        const cardNumber = $('input[name="cardNumber"]', checkoutForm);
        cardNumber.addEventListener('input', () => {
            const digits = cardNumber.value.replace(/\D/g, '').slice(0, 19);
            cardNumber.value = digits.replace(/(.{4})/g, '$1 ').trim();
        });
        const expiry = $('input[name="expiry"]', checkoutForm);
        expiry.addEventListener('input', () => {
            const digits = expiry.value.replace(/\D/g, '').slice(0, 4);
            expiry.value = digits.length > 2 ? `${digits.slice(0, 2)} / ${digits.slice(2)}` : digits;
        });
        const cvc = $('input[name="cvc"]', checkoutForm);
        cvc.addEventListener('input', () => { cvc.value = cvc.value.replace(/\D/g, '').slice(0, 4); });

        const cardLooksValid = value => {
            const digits = value.replace(/\D/g, '');
            if (digits.length < 12 || digits.length > 19) return false;
            let sum = 0;
            let double = false;
            for (let index = digits.length - 1; index >= 0; index -= 1) {
                let digit = Number(digits[index]);
                if (double) { digit *= 2; if (digit > 9) digit -= 9; }
                sum += digit;
                double = !double;
            }
            return sum % 10 === 0;
        };
        checkoutForm.addEventListener('submit', async event => {
            event.preventDefault();
            if (!checkoutForm.reportValidity()) return;
            const values = new FormData(checkoutForm);
            const expiryDigits = String(values.get('expiry')).replace(/\D/g, '');
            const month = Number(expiryDigits.slice(0, 2));
            const year = Number(`20${expiryDigits.slice(2, 4)}`);
            const now = new Date();
            if (!cardLooksValid(String(values.get('cardNumber')))) {
                $('input[name="cardNumber"]', checkoutForm).setCustomValidity('Enter a valid sample card number (for example, 4242 4242 4242 4242).');
                $('input[name="cardNumber"]', checkoutForm).reportValidity();
                $('input[name="cardNumber"]', checkoutForm).setCustomValidity('');
                return;
            }
            if (expiryDigits.length !== 4 || month < 1 || month > 12 || year < now.getFullYear() || (year === now.getFullYear() && month < now.getMonth() + 1)) {
                expiry.setCustomValidity('Enter a valid, future expiry date.');
                expiry.reportValidity();
                expiry.setCustomValidity('');
                return;
            }
            const button = $('button[type="submit"]', checkoutForm);
            setBusy(button, true, 'Setting up your demo…');
            try {
                const result = await api('purchase', { plan: values.get('plan') });
                checkoutForm.hidden = true;
                checkoutSuccess.hidden = false;
                $('[data-checkout-message]', checkoutSuccess).textContent = result.message;
            } catch (error) {
                if (error.message.toLowerCase().includes('sign in') || error.message.toLowerCase().includes('account')) {
                    window.location.assign('/login?next=pricing');
                } else {
                    let status = $('.checkout-error', checkoutForm);
                    if (!status) {
                        status = document.createElement('p');
                        status.className = 'form-response checkout-error';
                        checkoutForm.prepend(status);
                    }
                    status.textContent = responseText(error);
                }
            } finally {
                setBusy(button, false);
            }
        });
    }

    const languagePicker = $('#language-picker');
    const supportedLanguages = ['en', 'hy', 'ru'];
    if (languagePicker) {
        // Keep the main interface wording reviewed and consistent. The remote
        // translator remains a fallback for university data and less common copy.
        const interfaceTranslations = {
            hy: {
                'Home': 'Գլխավոր', 'Universities': 'Համալսարաններ', 'Destinations⌄': 'Երկրներ⌄',
                'Services': 'Ծառայություններ', 'About us': 'Մեր մասին', 'Contact us': 'Կապ',
                'Sign in': 'Մուտք', 'Log in': 'Մուտք գործել', 'Questions? Talk to UniPath': 'Հարցե՞ր ունեք։ Գրեք UniPath-ին',
                'UNIVERSITY ADMISSIONS, SIMPLIFIED': 'ՀԱՄԱԼՍԱՐԱՆ ԸՆԴՈՒՆՎԵԼԸ՝ ԱՎԵԼԻ ՊԱՐԶ',
                'Make your dream': 'Մոտեցրեք ձեր երազանքը', 'come true. ': 'իրականությանը։ ', 'Find': 'Գտեք', 'your path.': 'ձեր ուղին։',
                'Search programs, compare requirements, and keep your study-abroad plans in one straightforward place.': 'Փնտրեք ծրագրեր, համեմատեք պահանջները և արտասահմանում սովորելու ձեր ծրագիրը պահեք մեկ հարմար վայրում։',
                'Browse universities →': 'Դիտել համալսարանները →', 'See how we help': 'Տեսնել՝ ինչպես ենք օգնում',
                'destinations': 'երկիր', 'program examples': 'ծրագրի օրինակ', 'popular program examples': 'հայտնի ծրագրի օրինակ', 'universities': 'համալսարան',
                'EXPLORE DESTINATIONS': 'ԲԱՑԱՀԱՅՏԵՔ ԵՐԿՐՆԵՐԸ', 'Start with a place that feels right.': 'Սկսեք այն երկրից, որն իսկապես ձեզ է համապատասխանում։',
                'Explore all 22 destinations →': 'Դիտել բոլոր 20 երկրները →', 'This directory is a starting point with some of the most popular study areas. We can explore other programs with you during a guidance session.': 'Այս ցանկում ներկայացված են ամենապահանջված մասնագիտություններից մի քանիսը։ Խորհրդատվության ընթացքում միասին կքննարկենք նաև այլ ծրագրեր։', 'United Kingdom': 'Միացյալ Թագավորություն', 'United States': 'ԱՄՆ', 'United Arab Emirates': 'Արաբական Միացյալ Էմիրություններ', 'Other destinations →': 'Այլ ուղղություններ →',
                'Germany': 'Գերմանիա', 'Italy': 'Իտալիա', 'Canada': 'Կանադա', 'England · Scotland · Wales': 'Անգլիա · Շոտլանդիա · Ուելս',
                'Universities across the USA': 'Համալսարաններ ԱՄՆ-ում', 'Research and innovation': 'Հետազոտություններ և նորարարություն',
                'Culture and academic excellence': 'Մշակույթ և բարձրակարգ կրթություն', 'Research, opportunity and campus life': 'Հետազոտություն, հնարավորություններ և ուսանողական կյանք',
                'Explore →': 'Բացահայտել →', 'HOW WE CAN HELP': 'ԻՆՉՊԵՍ ԵՆՔ ՕԳՆՈՒՄ', 'Practical support for every step.': 'Գործնական աջակցություն՝ յուրաքանչյուր քայլում։',
                'From choosing a destination to preparing your documents, UniPath gives you one clear place to organize your next move.': 'Երկիր ընտրելուց մինչև փաստաթղթերը պատրաստելը՝ UniPath-ն օգնում է հստակ կազմակերպել ձեր հաջորդ քայլերը։',
                'Explore our support →': 'Ծանոթանալ մեր աջակցությանը →', 'University matching': 'Համալսարանի ընտրություն',
                'Compare universities and programs by country, subject, study mode and tuition.': 'Համեմատեք համալսարաններն ու ծրագրերը՝ ըստ երկրի, մասնագիտության, ուսուցման ձևի և վարձի։',
                'Browse programs →': 'Դիտել ծրագրերը →', 'Application planning': 'Դիմումի պլանավորում',
                'Keep entry requirements, key documents and application timelines in view.': 'Հետևեք ընդունելության պահանջներին, անհրաժեշտ փաստաթղթերին և դիմելու ժամկետներին։',
                'Explore requirements →': 'Դիտել պահանջները →', 'Scholarships & funding': 'Կրթաթոշակներ և ֆինանսավորում',
                'Look for programs with scholarships and include costs in your decision.': 'Գտեք կրթաթոշակով ծրագրեր և հաշվի առեք ծախսերը որոշում կայացնելիս։',
                'Find funding →': 'Գտնել ֆինանսավորում →', 'Your study journey': 'Ձեր ուսման ուղին',
                'Save options you like and return to your international study shortlist later.': 'Պահպանեք ձեզ հետաքրքրող տարբերակները և հետագայում վերադառնաք ձեր ցանկին։',
                'Create your account →': 'Ստեղծել հաշիվ →', 'YOUR PATH, MADE SIMPLE': 'ՁԵՐ ՈՒՂԻՆ՝ ԱՎԵԼԻ ՊԱՐԶ',
                'From first search to first day.': 'Առաջին որոնումից մինչև ուսման առաջին օրը։', 'Explore': 'Բացահայտել', 'Compare': 'Համեմատել',
                'Move forward': 'Շարունակել առաջ', '7 years': '7 տարի', 'Contact UniPath →': 'Կապվել UniPath-ի հետ →',
                '©': '©', 'Built for what comes next.': 'Ձեր հաջորդ քայլի համար։', 'Explore universities': 'Դիտել համալսարանները',
                'About UniPath': 'UniPath-ի մասին', 'UNIVERSITIES & PROGRAMS · 20 COUNTRIES': 'ՀԱՄԱԼՍԱՐԱՆՆԵՐ ԵՎ ԾՐԱԳՐԵՐ · 20 ԵՐԿԻՐ', 'Find your university.': 'Գտեք ձեր համալսարանը։',
                'Search opportunities and discover where you belong.': 'Փնտրեք հնարավորություններ և գտեք ձեզ համապատասխան վայրը։',
                'University, program, or field': 'Համալսարան, ծրագիր կամ մասնագիտություն', 'Any country': 'Ցանկացած երկիր', 'Any degree': 'Ցանկացած աստիճան',
                'Any field': 'Ցանկացած ոլորտ', 'Search →': 'Որոնել →', 'Filters': 'Զտիչներ', 'Reset': 'Մաքրել', 'Study mode': 'Ուսուցման ձև',
                'Any mode': 'Ցանկացած ձև', 'Full-time': 'Առկա', 'Part-time': 'Հեռակա', 'Indicative annual tuition': 'Տարեկան ուսման մոտավոր վարձ',
                'Minimum': 'Նվազագույն', 'Maximum': 'Առավելագույն', 'Planning estimates in USD. Confirm costs with the university.': 'Գումարները մոտավոր են՝ ԱՄՆ դոլարով։ Ճշտեք համալսարանից։',
                'Funding': 'Ֆինանսավորում', 'Scholarship opportunities': 'Կրթաթոշակներ', 'Sort by': 'Դասավորել ըստ', 'Relevance': 'Համապատասխանության',
                'University name': 'Համալսարանի անվան', 'Lowest tuition': 'Նվազագույն վարձի', 'Highest tuition': 'Առավելագույն վարձի',
                'programs found': 'ծրագիր է գտնվել', 'program found': 'ծրագիր է գտնվել', 'No programs match these filters. Try widening your search.': 'Այս զտիչներով ծրագրեր չկան։ Փոխեք որոնման չափանիշները։',
                'WELCOME BACK': 'ԲԱՐԻ ԳԱԼՈՒՍՏ ՎԵՐԱԴԱՐՁ', 'Continue your study journey.': 'Շարունակեք ձեր ուսման ուղին։',
                'Log in to save universities, manage your shortlist, and continue your application plan.': 'Մուտք գործեք՝ համալսարանները պահպանելու, ցանկը կառավարելու և դիմումի պլանը շարունակելու համար։',
                'Email address': 'Էլեկտրոնային փոստ', 'Password': 'Գաղտնաբառ', 'Enter your password': 'Մուտքագրեք գաղտնաբառը',
                'New to UniPath? ': 'Առաջին անգամ եք UniPath-ում՞ ', 'Create an account': 'Ստեղծել հաշիվ', '← Back to homepage': '← Վերադառնալ գլխավոր էջ',
                'YOUR NEXT CHAPTER': 'ՁԵՐ ՀԱՋՈՐԴ ՓՈՒԼԸ', 'Build your study abroad plan.': 'Կազմեք արտասահմանում սովորելու ձեր ծրագիրը։',
                'Your name': 'Ձեր անունը', 'Your full name': 'Անուն Ազգանուն', 'At least 8 characters': 'Առնվազն 8 նիշ',
                'Already have an account? ': 'Արդեն ունե՞ք հաշիվ։ ', 'Log in': 'Մուտք գործել',
                'UNIPATH GUIDANCE': 'UNIPATH-Ի ՈՒՂԵՑՈՒՅՑ', 'Support for every step of your application.': 'Աջակցություն՝ դիմումի յուրաքանչյուր քայլում։',
                '✓ Personal support': '✓ Անհատական աջակցություն', '✓ International university focus': '✓ Միջազգային համալսարաններ', '✓ Clear next steps': '✓ Հստակ հաջորդ քայլեր',
                'Complimentary first consultation': 'Առաջին խորհրդատվությունն անվճար է', 'Book your free first consultation →': 'Ամրագրել անվճար խորհրդատվություն →',
                'Choose the support you need.': 'Ընտրեք ձեզ անհրաժեշտ աջակցությունը։', 'Starter': 'Սկսնակ', 'Application': 'Դիմում',
                'University Shortlist': 'Համալսարանների ցանկ', 'Application Guidance': 'Դիմումի ուղեկցում', 'Essay support': 'Էսսեի աջակցություն',
                'Full Admissions Support': 'Ամբողջական աջակցություն', 'WHAT YOUR PACKAGE INCLUDES': 'ԻՆՉ Է ՆԵՐԱՌՎԱԾ ՓԱԹԵԹՈՒՄ',
                'GUIDANCE THAT FITS YOUR GOALS': 'ԱՋԱԿՑՈՒԹՅՈՒՆ՝ ԸՍՏ ՁԵՐ ՆՊԱՏԱԿՆԵՐԻ',
                'A clear starting point for students selecting suitable countries, universities and programs.': 'Հստակ մեկնարկ՝ երկիր, համալսարան և ուսումնական ծրագիր ընտրելու համար։',
                'Country and university recommendations': 'Երկրի և համալսարանի առաջարկներ', 'Program shortlist based on your profile': 'Ձեր տվյալներին համապատասխան ծրագրերի ցանկ',
                'Tuition and funding overview': 'Ուսման վարձի և ֆինանսավորման ամփոփում', '30-minute guidance session': '30 րոպեանոց խորհրդատվություն',
                'Application strategy and timeline': 'Դիմելու ռազմավարություն և ժամանակացույց', 'Document checklist and review': 'Փաստաթղթերի ցանկ և ստուգում',
                'Scholarship and deadline planning': 'Կրթաթոշակների և ժամկետների պլանավորում', 'Application form guidance': 'Դիմումի ձևաթղթերի լրացման աջակցություն',
                'Detailed structure feedback': 'Մանրամասն կարծիք՝ կառուցվածքի վերաբերյալ', 'Clarity, tone and content review': 'Հստակության, ոճի և բովանդակության ստուգում',
                'One revision review': 'Մեկ անգամ կրկնակի ստուգում', 'Interview preparation': 'Հարցազրույցի նախապատրաստում',
                'Visa document roadmap': 'Վիզայի փաստաթղթերի ուղեցույց', 'Pre-departure guidance': 'Մեկնումից առաջ խորհրդատվություն',
                'MOST POPULAR': 'ԱՄԵՆԱՀԱՅՏՆԻ', 'one-time': 'մեկանգամյա', 'per document': 'մեկ փաստաթղթի համար',
                'Choose Starter →': 'Ընտրել մեկնարկայինը →', 'Choose Application →': 'Ընտրել դիմումի փաթեթը →', 'Improve my essay →': 'Բարելավել իմ էսսեն →', 'Start my full path →': 'Սկսել ամբողջական աջակցությունը →',
                'ABOUT UNIPATH': 'UNIPATH-Ի ՄԱՍԻՆ', 'We make international education feel possible.': 'Մենք օգնում ենք միջազգային կրթությունը դարձնել հասանելի։',
                'Talk with our team →': 'Խոսել մեր թիմի հետ →', 'supporting study abroad journeys': 'աջակցում ենք արտասահմանում սովորել ցանկացողներին',
                'destinations to explore': 'երկիր՝ բացահայտելու համար', 'universities to explore': 'համալսարան՝ ուսումնասիրելու համար',
                'A PLAN FOR A BIG MOVE': 'ՄԵԾ ՔԱՅԼԻ ՀՍՏԱԿ ԾՐԱԳԻՐ', 'International applications are projects, too.': 'Միջազգային ընդունելությունն էլ է նախագիծ։',
                'Set the destination': 'Ընտրեք երկիրը', 'Map the milestones': 'Նշեք կարևոր ժամկետները', 'Keep the work together': 'Կազմակերպեք բոլոր քայլերը',
                'Check before you commit': 'Ստուգեք տվյալները՝ որոշումից առաջ', 'Ready to explore what’s out there?': 'Պատրա՞ստ եք բացահայտել հնարավորությունները։',
                'Start comparing universities in 22 destinations.': 'Սկսեք համեմատել համալսարանները 20 երկրում։',
                'Scholarship opportunities may be available': 'Հնարավոր են կրթաթոշակներ', 'Check university funding options': 'Ճշտեք ֆինանսավորման հնարավորությունները',
                '♡ Save university': '♡ Պահպանել համալսարանը', 'Program details →': 'Ծրագրի մանրամասները →', 'University site ↗': 'Համալսարանի կայք ↗',
                'Send a note below; the UniPath team will follow up.': 'Գրեք մեզ․ UniPath-ի թիմը կպատասխանի ձեզ։',
                'Mamikonyants 52': 'Մամիկոնյանց 52', 'Yerevan, Armenia': 'Երևան, Հայաստան', 'Instagram': 'Instagram', 'Facebook': 'Facebook',
                'Little ideas and useful reminders for the path ahead.': 'Օգտակար խորհուրդներ և հիշեցումներ ձեր առաջիկա քայլերի համար։',
                'Not sure what to ask? You can simply tell us where you are in your search.': 'Չգիտե՞ք՝ ինչ հարցնել։ Պատմեք, թե որ փուլում եք։',
                'What’s this about?': 'Ի՞նչ հարցով եք գրում', 'Choose a topic': 'Ընտրեք թեման', 'Finding a university': 'Համալսարանի ընտրություն',
                'Applications and planning': 'Դիմումներ և պլանավորում', 'My UniPath account': 'Իմ UniPath հաշիվը', 'Something else': 'Այլ հարց',
                'How should we address you?': 'Ինչպե՞ս դիմենք ձեզ', 'Add as much or as little detail as you like': 'Նկարագրեք հարցը ձեր նախընտրած չափով',
                'We’ll only use your details to respond to your message.': 'Ձեր տվյալները կօգտագործենք միայն հաղորդագրությանը պատասխանելու համար։',
                'A REAL PERSON, ON THE OTHER SIDE': 'ՄԵՐ ԹԻՄԸ ՄԱՍՆԱԿԻՑ Է', 'Questions are': 'Հարցերը', 'always welcome.': 'միշտ ողջունելի են։',
                'SAY HELLO': 'ԿԱՊ ՀԱՍՏԱՏԵԼ', 'We’d love to hear from you ': 'Ուրախ կլինենք լսել ձեզնից ', 'Visit our office': 'Այցելեք մեր գրասենյակ',
                'Call us': 'Զանգահարեք մեզ', 'FOLLOW ALONG': 'ՀԵՏԵՎԵՔ ՄԵԶ', 'WRITE US A NOTE': 'ԳՐԵՔ ՄԵԶ', 'What’s on': 'Ի՞նչ կա', 'your ': 'ձեր ',
                'Your message': 'Ձեր հաղորդագրությունը', 'Send your note ': 'Ուղարկել հաղորդագրությունը ', 'FIND UNIPATH': 'ԳՏԵՔ UNIPATH-Ը',
                'Come say hello in Yerevan.': 'Սպասում ենք ձեզ Երևանում։', 'Open pinned address in Google Maps ↗': 'Բացել հասցեն Google Քարտեզներում ↗'
            },
            ru: {
                'Home': 'Главная', 'Universities': 'Университеты', 'Destinations⌄': 'Страны⌄', 'Services': 'Услуги', 'About us': 'О нас', 'Contact us': 'Контакты',
                'Sign in': 'Войти', 'Log in': 'Войти', 'Questions? Talk to UniPath': 'Есть вопросы? Напишите UniPath',
                'UNIVERSITY ADMISSIONS, SIMPLIFIED': 'ПОСТУПЛЕНИЕ В УНИВЕРСИТЕТ — ПРОЩЕ',
                'Make your dream': 'Воплотите свою мечту', 'come true. ': 'в жизнь. ', 'Find': 'Найдите', 'your path.': 'свой путь.',
                'Search programs, compare requirements, and keep your study-abroad plans in one straightforward place.': 'Ищите программы, сравнивайте требования и планируйте учёбу за рубежом в одном удобном месте.',
                'Browse universities →': 'Смотреть университеты →', 'See how we help': 'Как мы помогаем', 'destinations': 'направлений', 'universities': 'университетов', 'program examples': 'примеров программ', 'popular program examples': 'популярных примеров программ',
                'EXPLORE DESTINATIONS': 'ВЫБЕРИТЕ СТРАНУ', 'Start with a place that feels right.': 'Начните со страны, которая вам подходит.', 'Explore all 22 destinations →': 'Все 20 направлений →', 'This directory is a starting point with some of the most popular study areas. We can explore other programs with you during a guidance session.': 'Здесь собраны некоторые из самых популярных направлений. Другие программы мы обсудим вместе на консультации.',
                'United Kingdom': 'Великобритания', 'United States': 'США', 'United Arab Emirates': 'Объединённые Арабские Эмираты', 'Other destinations →': 'Другие направления →', 'Germany': 'Германия', 'Italy': 'Италия', 'Canada': 'Канада',
                'England · Scotland · Wales': 'Англия · Шотландия · Уэльс', 'Universities across the USA': 'Университеты по всей территории США',
                'Research and innovation': 'Наука и инновации', 'Culture and academic excellence': 'Культура и академические достижения',
                'Research, opportunity and campus life': 'Наука, возможности и жизнь кампуса', 'Explore →': 'Подробнее →',
                'HOW WE CAN HELP': 'ЧЕМ МЫ МОЖЕМ ПОМОЧЬ', 'Practical support for every step.': 'Практическая поддержка на каждом этапе.',
                'From choosing a destination to preparing your documents, UniPath gives you one clear place to organize your next move.': 'От выбора страны до подготовки документов — UniPath помогает собрать все следующие шаги в одном месте.',
                'Explore our support →': 'Узнать о поддержке →', 'University matching': 'Подбор университета',
                'Compare universities and programs by country, subject, study mode and tuition.': 'Сравнивайте университеты и программы по стране, специальности, формату обучения и стоимости.',
                'Browse programs →': 'Смотреть программы →', 'Application planning': 'Планирование поступления',
                'Keep entry requirements, key documents and application timelines in view.': 'Следите за требованиями, документами и сроками подачи заявок.', 'Explore requirements →': 'Изучить требования →',
                'Scholarships & funding': 'Стипендии и финансирование', 'Look for programs with scholarships and include costs in your decision.': 'Ищите программы со стипендиями и учитывайте расходы при выборе.',
                'Find funding →': 'Найти финансирование →', 'Your study journey': 'Ваш путь к обучению',
                'Save options you like and return to your international study shortlist later.': 'Сохраняйте подходящие варианты и возвращайтесь к списку университетов позже.',
                'Create your account →': 'Создать аккаунт →', 'YOUR PATH, MADE SIMPLE': 'ВАШ ПУТЬ — ПРОЩЕ', 'From first search to first day.': 'От первого поиска до первого учебного дня.',
                'Explore': 'Выбирайте', 'Compare': 'Сравнивайте', 'Move forward': 'Действуйте', '7 years': '7 лет', 'Contact UniPath →': 'Связаться с UniPath →',
                'Built for what comes next.': 'Для вашего следующего шага.', 'Explore universities': 'Университеты', 'UNIVERSITIES & PROGRAMS · 20 COUNTRIES': 'УНИВЕРСИТЕТЫ И ПРОГРАММЫ · 20 СТРАН',
                'Find your university.': 'Найдите свой университет.', 'Search opportunities and discover where you belong.': 'Изучайте возможности и найдите подходящее место.',
                'University, program, or field': 'Университет, программа или направление', 'Any country': 'Любая страна', 'Any degree': 'Любая степень', 'Any field': 'Любая область', 'Search →': 'Найти →',
                'Filters': 'Фильтры', 'Reset': 'Сбросить', 'Study mode': 'Формат обучения', 'Any mode': 'Любой формат', 'Full-time': 'Очное', 'Part-time': 'Заочное',
                'Indicative annual tuition': 'Примерная стоимость за год', 'Minimum': 'От', 'Maximum': 'До',
                'Planning estimates in USD. Confirm costs with the university.': 'Ориентировочная сумма в долларах США. Уточняйте стоимость в университете.',
                'Funding': 'Финансирование', 'Scholarship opportunities': 'Возможность получить стипендию', 'Sort by': 'Сортировать:', 'Relevance': 'Релевантности',
                'University name': 'Названию университета', 'Lowest tuition': 'Сначала дешевле', 'Highest tuition': 'Сначала дороже',
                'programs found': 'программ найдено', 'program found': 'программа найдена', 'No programs match these filters. Try widening your search.': 'По этим фильтрам ничего не найдено. Измените параметры поиска.',
                'WELCOME BACK': 'С ВОЗВРАЩЕНИЕМ', 'Continue your study journey.': 'Продолжите свой путь к учёбе за рубежом.',
                'Log in to save universities, manage your shortlist, and continue your application plan.': 'Войдите, чтобы сохранять университеты, управлять списком и продолжать план поступления.',
                'Email address': 'Электронная почта', 'Password': 'Пароль', 'Enter your password': 'Введите пароль', 'New to UniPath? ': 'Впервые в UniPath? ',
                'Create an account': 'Создать аккаунт', '← Back to homepage': '← На главную', 'YOUR NEXT CHAPTER': 'ВАША СЛЕДУЮЩАЯ ГЛАВА',
                'Build your study abroad plan.': 'Составьте план обучения за рубежом.', 'Your name': 'Ваше имя', 'Your full name': 'Имя и фамилия', 'At least 8 characters': 'Не менее 8 символов',
                'Already have an account? ': 'Уже есть аккаунт? ', 'UNIPATH GUIDANCE': 'ПОДДЕРЖКА UNIPATH',
                'Support for every step of your application.': 'Помощь на каждом этапе поступления.', '✓ Personal support': '✓ Индивидуальная поддержка',
                '✓ International university focus': '✓ Международные университеты', '✓ Clear next steps': '✓ Понятный план действий',
                'Complimentary first consultation': 'Первая консультация бесплатно', 'Book your free first consultation →': 'Записаться на бесплатную консультацию →',
                'Choose the support you need.': 'Выберите подходящую поддержку.', 'Starter': 'Стартовый', 'Application': 'Поступление', 'University Shortlist': 'Подбор университетов',
                'Application Guidance': 'Сопровождение поступления', 'Essay support': 'Помощь с эссе', 'Full Admissions Support': 'Полное сопровождение',
                'GUIDANCE THAT FITS YOUR GOALS': 'ПОДДЕРЖКА ДЛЯ ВАШИХ ЦЕЛЕЙ',
                'A clear starting point for students selecting suitable countries, universities and programs.': 'Понятный старт при выборе страны, университета и подходящих программ.',
                'Country and university recommendations': 'Рекомендации по странам и университетам', 'Program shortlist based on your profile': 'Список программ с учётом вашего профиля',
                'Tuition and funding overview': 'Обзор стоимости обучения и финансирования', '30-minute guidance session': '30-минутная консультация',
                'Application strategy and timeline': 'Стратегия и сроки поступления', 'Document checklist and review': 'Список и проверка документов',
                'Scholarship and deadline planning': 'Планирование стипендий и сроков', 'Application form guidance': 'Помощь с формами заявлений',
                'Detailed structure feedback': 'Подробные рекомендации по структуре', 'Clarity, tone and content review': 'Проверка ясности, стиля и содержания',
                'One revision review': 'Одна повторная проверка', 'Interview preparation': 'Подготовка к собеседованию',
                'Visa document roadmap': 'План подготовки визовых документов', 'Pre-departure guidance': 'Подготовка к отъезду',
                'MOST POPULAR': 'ПОПУЛЯРНЫЙ ВЫБОР', 'one-time': 'разовый платёж', 'per document': 'за документ',
                'Choose Starter →': 'Выбрать стартовый →', 'Choose Application →': 'Выбрать пакет поступления →', 'Improve my essay →': 'Улучшить моё эссе →', 'Start my full path →': 'Начать полное сопровождение →',
                'ABOUT UNIPATH': 'О UNIPATH', 'We make international education feel possible.': 'Мы помогаем сделать международное образование доступнее.',
                'Talk with our team →': 'Поговорить с командой →', 'supporting study abroad journeys': 'помогаем учиться за рубежом',
                'destinations to explore': 'направлений для изучения', 'universities to explore': 'университетов для выбора',
                'A PLAN FOR A BIG MOVE': 'ПЛАН ДЛЯ ВАЖНОГО ШАГА', 'International applications are projects, too.': 'Поступление за рубеж — это тоже проект.',
                'Set the destination': 'Выберите страну', 'Map the milestones': 'Отметьте ключевые сроки', 'Keep the work together': 'Соберите все задачи вместе',
                'Check before you commit': 'Проверьте данные перед решением', 'Ready to explore what’s out there?': 'Готовы узнать о своих возможностях?',
                'Start comparing universities in 22 destinations.': 'Начните сравнивать университеты в 20 странах.',
                'Scholarship opportunities may be available': 'Могут быть доступны стипендии', 'Check university funding options': 'Уточните варианты финансирования в вузе',
                '♡ Save university': '♡ Сохранить университет', 'Program details →': 'Подробнее о программе →', 'University site ↗': 'Сайт университета ↗',
                'Send a note below; the UniPath team will follow up.': 'Напишите нам — команда UniPath ответит вам.',
                'Mamikonyants 52': 'Мамиконянц, 52', 'Yerevan, Armenia': 'Ереван, Армения', 'Instagram': 'Instagram', 'Facebook': 'Facebook',
                'Little ideas and useful reminders for the path ahead.': 'Полезные советы и напоминания на вашем пути.',
                'Not sure what to ask? You can simply tell us where you are in your search.': 'Не знаете, о чём спросить? Расскажите, на каком этапе поиска вы находитесь.',
                'What’s this about?': 'Тема обращения', 'Choose a topic': 'Выберите тему', 'Finding a university': 'Выбор университета',
                'Applications and planning': 'Поступление и планирование', 'My UniPath account': 'Мой аккаунт UniPath', 'Something else': 'Другое',
                'How should we address you?': 'Как к вам обращаться?', 'Add as much or as little detail as you like': 'Опишите вопрос настолько подробно, насколько хотите',
                'We’ll only use your details to respond to your message.': 'Ваши данные будут использованы только для ответа на сообщение.',
                'WHAT YOUR PACKAGE INCLUDES': 'ЧТО ВХОДИТ В ПАКЕТ', 'A REAL PERSON, ON THE OTHER SIDE': 'МЫ ВСЕГДА НА СВЯЗИ',
                'Questions are': 'Мы всегда', 'always welcome.': 'рады вашим вопросам.', 'SAY HELLO': 'СВЯЖИТЕСЬ С НАМИ', 'We’d love to hear from you ': 'Будем рады вашему сообщению ',
                'Visit our office': 'Наш офис', 'Call us': 'Позвоните нам', 'FOLLOW ALONG': 'МЫ В СОЦСЕТЯХ', 'WRITE US A NOTE': 'НАПИШИТЕ НАМ',
                'What’s on': 'Что у', 'your ': 'вас ', 'Your message': 'Ваше сообщение', 'Send your note ': 'Отправить сообщение ', 'FIND UNIPATH': 'КАК НАС НАЙТИ',
                'Come say hello in Yerevan.': 'Будем рады видеть вас в Ереване.', 'Open pinned address in Google Maps ↗': 'Открыть адрес в Google Картах ↗'
            }
        };
        const selected = localStorage.getItem('unipath-language') || 'en';
        languagePicker.value = supportedLanguages.includes(selected) ? selected : 'en';
        const originalText = new WeakMap();
        const originalAttributes = new WeakMap();
        const knownTextNodes = new Map();
        const knownAttributes = new Map();
        const collectTargets = () => {
            knownTextNodes.forEach(item => { item.node.nodeValue = item.original; });
            knownAttributes.forEach(attributes => Object.values(attributes).forEach(item => item.element.setAttribute(item.attribute, item.original)));
            const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
                acceptNode(node) {
                    if (!node.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
                    if (node.parentElement?.closest('script,style,noscript,svg,[data-no-translate],[hidden]')) return NodeFilter.FILTER_REJECT;
                    return NodeFilter.FILTER_ACCEPT;
                }
            });
            while (walker.nextNode()) {
                const node = walker.currentNode;
                if (!originalText.has(node)) originalText.set(node, node.nodeValue);
                knownTextNodes.set(node, { node, original: originalText.get(node) });
            }
            $$('[placeholder],[aria-label],[title]').forEach(element => {
                if (element.closest('[data-no-translate]')) return;
                ['placeholder', 'aria-label', 'title'].forEach(attribute => {
                    const value = element.getAttribute(attribute);
                    if (!value?.trim()) return;
                    let originals = originalAttributes.get(element);
                    if (!originals) { originals = {}; originalAttributes.set(element, originals); }
                    if (!(attribute in originals)) originals[attribute] = value;
                    let items = knownAttributes.get(element);
                    if (!items) { items = {}; knownAttributes.set(element, items); }
                    items[attribute] = { element, attribute, original: originals[attribute] };
                });
            });
            return { textNodes: [...knownTextNodes.values()], translatedAttributes: [...knownAttributes.values()].flatMap(Object.values) };
        };
        let translationRun = 0;
        const translationNotice = () => {
            let notice = $('#translation-notice');
            if (!notice) {
                notice = document.createElement('div');
                notice.id = 'translation-notice';
                notice.setAttribute('role', 'status');
                notice.style.cssText = 'position:fixed;right:14px;bottom:14px;z-index:30;max-width:340px;padding:12px 16px;background:#081b3b;color:white;font:12px/1.6 sans-serif;box-shadow:0 5px 25px #0002';
                document.body.append(notice);
            }
            return notice;
        };
        const translatePage = async target => {
            const run = ++translationRun;
            const notice = translationNotice();
            const { textNodes, translatedAttributes } = collectTargets();
            if (target === 'en') { notice.remove(); return; }
            notice.textContent = target === 'hy' ? 'Թարգմանությունը բեռնվում է…' : 'Перевод загружается…';
            // Version the cache so earlier broken machine translations are never reused.
            const cacheKey = `unipath-translation-v2-${target}`;
            let cache;
            try { cache = JSON.parse(localStorage.getItem(cacheKey) || '{}'); } catch { cache = {}; }
            const curated = interfaceTranslations[target] || {};
            const distinct = [...new Set([...textNodes.map(item => item.original), ...translatedAttributes.map(item => item.original)].map(value => value.trim()).filter(Boolean))];
            let cursor = 0;
            let failures = 0;
            const worker = async () => {
                while (cursor < distinct.length && run === translationRun) {
                    const text = distinct[cursor++];
                    if (curated[text]) { cache[text] = curated[text]; continue; }
                    if (cache[text]) continue;
                    try {
                        const result = await api('translate', { q: text, source: 'en', target });
                        cache[text] = result.translatedText;
                        localStorage.setItem(cacheKey, JSON.stringify(cache));
                    } catch { failures += 1; }
                }
            };
            // Free translation endpoints throttle concurrent requests. A single
            // worker avoids partial pages and mixed-language navigation.
            await worker();
            if (run !== translationRun) return;
            textNodes.forEach(item => {
                const original = item.original;
                const leading = original.match(/^\s*/)?.[0] || '';
                const trailing = original.match(/\s*$/)?.[0] || '';
                item.node.nodeValue = `${leading}${cache[original.trim()] || original.trim()}${trailing}`;
            });
            translatedAttributes.forEach(item => {
                item.element.setAttribute(item.attribute, cache[item.original.trim()] || item.original);
            });
            if (failures) {
                notice.textContent = target === 'hy' ? 'Թարգմանության ծառայությունը ժամանակավորապես անհասանելի է. չթարգմանված տեքստը մնացել է անգլերեն:' : 'Сервис перевода временно недоступен. Непереведённый текст остался на английском.';
                window.setTimeout(() => notice.remove(), 7000);
            } else notice.remove();
        };
        let activeLanguage = languagePicker.value;
        window.addEventListener('unipath:translate-visible', () => {
            if (activeLanguage !== 'en') translatePage(activeLanguage);
        });
        languagePicker.addEventListener('change', () => {
            const language = languagePicker.value;
            activeLanguage = language;
            localStorage.setItem('unipath-language', language);
            document.documentElement.lang = language;
            translatePage(language);
        });
        if (languagePicker.value !== 'en') {
            document.documentElement.lang = languagePicker.value;
            translatePage(languagePicker.value);
        }
    }
})();
