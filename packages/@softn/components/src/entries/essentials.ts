/**
 * The components the runtimes register at start-up, in the shell: every
 * layout piece, the text and the media, the commonest form controls and the
 * list. Counted across the published demos, the repository's examples,
 * Studio's own examples and agent guide and the guides (2026-10-22), these
 * are what nearly every app draws; the next most used component appeared in
 * three apps of 26, and 42 of the other components of the old minimal set in
 * none. The wrappers stay here too (Form, Field, List and the layout): drawn
 * before its chunk had arrived, a wrapper would hide everything inside it.
 *
 * Everything else is on demand: the five groups beside this file (controls,
 * feedback, data, display, navigation), fetched the first time a page draws
 * one of their components and waited for before a page's first draw, and the
 * heavier features (lazy.ts).
 */

export * from '../layout';
export * from '../display/Text';
export * from '../display/Heading';
export * from '../display/Badge';
export * from '../display/Image';
export * from '../display/Icon';
export * from '../display/Spinner';
export * from '../form/Button';
export * from '../form/Input';
export * from '../form/TextArea';
export * from '../form/Form';
export * from '../form/Field';
export * from '../feedback/EmptyState';
export * from '../data/List';
export * from '../utility/Loop';

import { Stack } from '../layout/Stack';
import { Box } from '../layout/Box';
import { Card } from '../layout/Card';
import { Grid } from '../layout/Grid';
import { Container } from '../layout/Container';
import { Divider } from '../layout/Divider';
import { Spacer } from '../layout/Spacer';
import { Center } from '../layout/Center';
import { Sidebar } from '../layout/Sidebar';
import { Split } from '../layout/Split';
import { App } from '../layout/App';
import { Layout } from '../layout/Layout';
import { Header } from '../layout/Header';
import { Content } from '../layout/Content';
import { Section } from '../layout/Section';
import { Text } from '../display/Text';
import { Heading } from '../display/Heading';
import { Badge } from '../display/Badge';
import { Image } from '../display/Image';
import { Icon } from '../display/Icon';
import { Spinner } from '../display/Spinner';
import { Button } from '../form/Button';
import { Input } from '../form/Input';
import { TextArea } from '../form/TextArea';
import { Form } from '../form/Form';
import { Field } from '../form/Field';
import { EmptyState } from '../feedback/EmptyState';
import { List, ListItem } from '../data/List';
import { Loop } from '../utility/Loop';

/** The start-up set, by registry name. */
export const essentialComponents = {
  // Layout
  Stack,
  Box,
  Card,
  Grid,
  Container,
  Divider,
  Spacer,
  Center,
  Sidebar,
  Split,
  App,
  Layout,
  Header,
  Content,
  Section,

  // Text and media
  Text,
  Heading,
  Badge,
  Image,
  Icon,
  Spinner,

  // The commonest form controls and their wrappers
  Button,
  Input,
  TextArea,
  Form,
  Field,

  // Lists and what an empty one shows
  List,
  ListItem,
  EmptyState,
  Loop,
};
