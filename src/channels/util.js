export function who(user) {
  const name = [user.first_name, user.last_name].filter(Boolean).join(' ');
  return user.username ? `${name} (@${user.username})` : name;
}

export { errMsg } from '../util/format.js';
