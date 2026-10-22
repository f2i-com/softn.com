/**
 * The display pieces beyond text and images: avatars, tags, progress bars,
 * skeletons, stats, key caps and description lists. Fetched the first time a
 * page draws one; Text, Heading, Badge, Image, Icon and Spinner are in the
 * start-up set.
 */
export * from '../display/Avatar';
export * from '../display/Tag';
export * from '../display/Progress';
export * from '../display/Skeleton';
export * from '../display/Stat';
export * from '../display/Kbd';
export * from '../display/DescriptionList';

import { Avatar, AvatarGroup } from '../display/Avatar';
import { Tag, TagGroup } from '../display/Tag';
import { Progress } from '../display/Progress';
import { Skeleton } from '../display/Skeleton';
import { Stat } from '../display/Stat';
import { Kbd } from '../display/Kbd';
import { DescriptionList } from '../display/DescriptionList';

export const displayComponents = {
  Avatar,
  AvatarGroup,
  Tag,
  TagGroup,
  Progress,
  Skeleton,
  Stat,
  Kbd,
  DescriptionList,
};
