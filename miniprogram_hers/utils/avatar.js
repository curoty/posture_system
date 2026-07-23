const AVATAR_PRESETS = [
  "/images/avatars/minimal-01.svg",
  "/images/avatars/minimal-02.svg",
  "/images/avatars/minimal-03.svg",
  "/images/avatars/minimal-04.svg",
  "/images/avatars/minimal-05.svg",
  "/images/avatars/minimal-06.svg",
  "/images/avatars/minimal-07.svg",
  "/images/avatars/minimal-08.svg",
];

const hashSeed = (seed) => {
  const text = String(seed || "guest");
  let hash = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash += (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24);
  }
  return hash >>> 0;
};

const pickRandomAvatar = (seed) => {
  const size = AVATAR_PRESETS.length;
  if (!size) {
    return "/images/avatar.png";
  }
  const index = hashSeed(seed) % size;
  return AVATAR_PRESETS[index];
};

const resolveAvatarSeed = (user, fallback) => {
  const safe = user && typeof user === "object" ? user : {};
  return (
    safe._id
    || safe.id
    || safe.openid
    || safe.phone
    || safe.name
    || fallback
    || "guest"
  );
};

module.exports = {
  AVATAR_PRESETS,
  pickRandomAvatar,
  resolveAvatarSeed,
};

