const ALTERNATE_TERMS = ['live', 'remix', 'karaoke', 'tribute', 'cover', 'instrumental', 'acoustic', 'sped up', 'slowed', 're-recorded'];

export function normalizeText(value) {
  return String(value ?? '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[’‘`]/g, "'")
    .replace(/[–—]/g, '-')
    .replace(/\b(?:featuring|feat\.?|ft\.?)\b/gi, ' ')
    .replace(/&/g, ' and ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .toLowerCase()
    .trim()
    .replace(/\s+/g, ' ');
}

function tokenSet(value) {
  return new Set(normalizeText(value).split(' ').filter(Boolean));
}

function overlap(left, right) {
  if (!left.size || !right.size) return 0;
  let matches = 0;
  for (const token of left) if (right.has(token)) matches += 1;
  return matches / Math.max(left.size, right.size);
}

function hasTerm(value, term) {
  return normalizeText(value).includes(normalizeText(term));
}

export function scoreCandidate(source, candidate, index = 0) {
  const sourceTitle = normalizeText(source.title);
  const candidateTitle = normalizeText(candidate.title);
  const sourceArtists = source.artists.map(normalizeText).filter(Boolean);
  const candidateArtists = candidate.artists.map(normalizeText).filter(Boolean);
  let score = 0;

  if (sourceTitle === candidateTitle) score += 100;
  else score += overlap(tokenSet(sourceTitle), tokenSet(candidateTitle)) * 60;

  if (sourceArtists[0] && sourceArtists[0] === candidateArtists[0]) score += 80;
  else score += overlap(tokenSet(sourceArtists[0]), tokenSet(candidateArtists.join(' '))) * 45;

  const sourceArtistTokens = tokenSet(sourceArtists.join(' '));
  score += overlap(sourceArtistTokens, tokenSet(candidateArtists.join(' '))) * 30;

  const versionText = `${candidate.title} ${candidate.version ?? ''} ${candidate.album ?? ''}`;
  for (const term of ALTERNATE_TERMS) {
    if (hasTerm(versionText, term) && !hasTerm(source.title, term)) score -= 35;
  }
  if (candidate.albumType === 'ALBUM') score += 4;

  return { score, index };
}

export function rankCandidates(source, candidates) {
  return candidates
    .map((candidate, index) => ({ candidate, ...scoreCandidate(source, candidate, index) }))
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .map(({ candidate }) => candidate);
}
