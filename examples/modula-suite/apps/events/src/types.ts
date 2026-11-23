export interface EventItem {
  id: number;
  title: string;
  category: string;
  event_date: string;
  location: string;
  capacity: number;
  ticket_price: number;
  status: string;
  description: string;
  registered_count: number;
  checked_in_count: number;
}

export interface EventRegistration {
  id: number;
  ticket_code: string;
  event_id: number;
  attendee_name: string;
  attendee_email: string;
  company: string;
  ticket_tier: string;
  amount_paid: number;
  checked_in: number;
  checked_in_at: string;
  created_at: string;
}

export interface SurveyItem {
  id: number;
  title: string;
  kind: string;
  status: string;
  prompt_text: string;
  created_at: string;
  response_count: number;
  avg_score: number;
  nps: number;
}

export interface SurveyResponse {
  id: number;
  survey_id: number;
  respondent_name: string;
  score: number;
  comment: string;
  created_at: string;
}

export interface CourseItem {
  id: number;
  title: string;
  category: string;
  instructor_name: string;
  level: string;
  duration_min: number;
  published: number;
  description: string;
  lesson_count: number;
  completed_count: number;
}

export interface LessonItem {
  id: number;
  course_id: number;
  position: number;
  title: string;
  lesson_type: string;
  duration_min: number;
  content_text: string;
  completed: number;
}

export interface EventsOverview {
  publishedEvents: number;
  totalRegistrations: number;
  checkedInCount: number;
  ticketRevenue: number;
  npsScore: number;
  responseCount: number;
  coursesCount: number;
  completionRate: number;
}
