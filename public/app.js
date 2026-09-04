const form = document.getElementById('lookupForm');
const input = document.getElementById('username');
const submitBtn = document.getElementById('submitBtn');
const buttonText = document.getElementById('buttonText');
const errorBox = document.getElementById('errorBox');
const loadingBox = document.getElementById('loadingBox');
const result = document.getElementById('result');
const el = (id) => document.getElementById(id);

function cleanUsername(value) { return String(value || '').trim().replace(/^@/, ''); }
function validUsername(value) { return /^[A-Za-z0-9._]{2,24}$/.test(value); }
function compact(value) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return '—';
  return new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(Number(value));
}
function fullNumber(value) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return '—';
  return new Intl.NumberFormat('en').format(Number(value));
}
function countryName(code) {
  if (!code) return null;
  try { return new Intl.DisplayNames(['en'], { type: 'region' }).of(code.toUpperCase()) || code.toUpperCase(); }
  catch { return code.toUpperCase(); }
}
function flagEmoji(code) {
  if (!code || !/^[A-Z]{2}$/.test(code.toUpperCase())) return '';
  return String.fromCodePoint(...code.toUpperCase().split('').map((letter) => 127397 + letter.charCodeAt(0)));
}
function formatDate(value) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat('en', { year: 'numeric', month: 'short', day: 'numeric' }).format(date);
}
function setBusy(busy) {
  submitBtn.disabled = busy;
  buttonText.textContent = busy ? 'Searching…' : 'Fetch Data';
  loadingBox.classList.toggle('hidden', !busy);
}
function showError(message) {
  errorBox.textContent = message;
  errorBox.classList.remove('hidden');
}
function clearState() {
  errorBox.classList.add('hidden');
  errorBox.textContent = '';
  result.classList.add('hidden');
}
function renderProfile(p) {
  el('displayName').textContent = p.displayName || p.username;
  el('handle').textContent = `@${p.username}`;
  el('bio').textContent = p.bio || '';
  el('verified').classList.toggle('hidden', !p.verified);
  el('openProfile').href = p.profileUrl;
  const avatar = el('avatar');
  const fallback = el('avatarFallback');
  if (p.avatarUrl) {
    avatar.src = p.avatarUrl;
    avatar.classList.remove('hidden');
    fallback.classList.add('hidden');
  } else {
    avatar.classList.add('hidden');
    fallback.textContent = (p.displayName || p.username || 'T').slice(0, 1).toUpperCase();
    fallback.classList.remove('hidden');
  }
  el('followers').textContent = compact(p.followerCount);
  el('followers').title = fullNumber(p.followerCount);
  el('following').textContent = compact(p.followingCount);
  el('following').title = fullNumber(p.followingCount);
  el('likes').textContent = compact(p.likesCount);
  el('likes').title = fullNumber(p.likesCount);
  el('videos').textContent = compact(p.videoCount);
  el('friends').textContent = compact(p.friendCount);
  el('diggs').textContent = compact(p.diggCount);
  const name = countryName(p.regionCode);
  el('region').textContent = name ? `${flagEmoji(p.regionCode)} ${name} (${p.regionCode})` : 'Not publicly available';
  el('regionNote').textContent = p.regionCode
    ? `Explicit region field found in the public TikTok profile data (${p.regionSource || 'source field'}).`
    : 'No explicit account-region field was found in the public profile data. TTT does not guess from bio, language, flags, or videos.';
  el('language').textContent = p.language || '—';
  el('userId').textContent = p.userId || '—';
  el('privacyStatus').textContent = p.privateAccount === null ? '—' : (p.privateAccount ? 'Private' : 'Public');
  el('created').textContent = formatDate(p.createTime);
  el('nicknameChanged').textContent = formatDate(p.nicknameModifiedAt);
  el('usernameChanged').textContent = formatDate(p.usernameModifiedAt);
  result.classList.remove('hidden');
  result.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const username = cleanUsername(input.value);
  clearState();
  if (!validUsername(username)) {
    showError('Enter a valid TikTok username using letters, numbers, periods, or underscores.');
    return;
  }
  setBusy(true);
  try {
    const response = await fetch(`/api/lookup/${encodeURIComponent(username)}`);
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || 'Lookup failed.');
    if (!data.profile) throw new Error('No profile data returned.');
    renderProfile(data.profile);
  } catch (error) {
    showError(error.message || 'Lookup failed. Try again.');
  } finally {
    setBusy(false);
  }
});
