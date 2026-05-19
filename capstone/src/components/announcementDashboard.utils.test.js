import {
  getAnnouncementUserId,
  getAnnouncementUserName,
  isAnnouncementStatusError,
  updateAnnouncementCollection,
  removeAnnouncementFromCollection,
} from './announcementDashboard.utils';

test('resolves announcement user id from common account shapes', () => {
  expect(getAnnouncementUserId({ id: 11 })).toBe(11);
  expect(getAnnouncementUserId({ user_id: '12' })).toBe(12);
  expect(getAnnouncementUserId({ account_id: '13' })).toBe(13);
  expect(getAnnouncementUserId({ id: 'x' })).toBeNull();
});

test('resolves announcement display name from common account shapes', () => {
  expect(getAnnouncementUserName({ name: 'Teacher One' })).toBe('Teacher One');
  expect(getAnnouncementUserName({ full_name: 'Teacher Two' })).toBe('Teacher Two');
  expect(getAnnouncementUserName(null, 'Teacher')).toBe('Teacher');
});

test('classifies announcement status messages', () => {
  expect(isAnnouncementStatusError('Failed to post announcement.')).toBe(true);
  expect(isAnnouncementStatusError('Announcement posted to parents.')).toBe(false);
});

test('updates and removes announcement items without duplicating them', () => {
  const items = [
    { id: 1, title: 'Old' },
    { id: 2, title: 'Keep' },
  ];

  expect(updateAnnouncementCollection(items, { id: 1, title: 'New' })).toEqual([
    { id: 1, title: 'New' },
    { id: 2, title: 'Keep' },
  ]);

  expect(updateAnnouncementCollection(items, { id: 3, title: 'Added' })).toEqual([
    { id: 3, title: 'Added' },
    { id: 1, title: 'Old' },
    { id: 2, title: 'Keep' },
  ]);

  expect(removeAnnouncementFromCollection(items, 2)).toEqual([
    { id: 1, title: 'Old' },
  ]);
});
