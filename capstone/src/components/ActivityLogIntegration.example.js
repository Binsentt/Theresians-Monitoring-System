// =========================================
// ACTIVITY LOG INTEGRATION EXAMPLES
// For Admin and Teacher Portals
// =========================================

/**
 * ADMIN PORTAL - View All Activity Logs
 * Location: /admin/activity-log
 * Access: Admins can view all student activity across all grades and sections
 */
import ActivityLog from './ActivityLog';

export function AdminActivityLogPage() {
  const currentUser = JSON.parse(localStorage.getItem('loggedInUser'));

  return (
    <div className="admin-activity-log-page">
      <ActivityLog 
        role="admin"          // Admin can see all activity logs
        limit={100}           // Fetch up to 100 records
        userId={null}         // No user restriction for admin
      />
    </div>
  );
}

/**
 * TEACHER PORTAL - View Assigned Students' Activity
 * Location: /teacher/activity-log
 * Access: Teachers can only view activity logs of their assigned students
 */
export function TeacherActivityLogPage() {
  const currentUser = JSON.parse(localStorage.getItem('loggedInUser'));
  const teacherId = currentUser?.id;

  return (
    <div className="teacher-activity-log-page">
      <ActivityLog 
        role="teacher"        // Teacher role
        limit={50}            // Fetch up to 50 records
        userId={teacherId}    // Pass teacher ID to filter by assigned students
      />
    </div>
  );
}

/**
 * EXAMPLE USAGE IN COMPONENTS
 * 
 * Usage in AdminDashboard:
 * -------------------------
 */
// In AdminDashboard.js
import ActivityLog from './ActivityLog';

export default function AdminDashboard() {
  // ... existing code ...

  return (
    <DashboardContainer
      sidebar={/* sidebar */}
      main={
        <MainContent>
          {/* ... other content ... */}

          <ContentSection title="Recent Student Activity">
            <ActivityLog 
              role="admin" 
              limit={100}
            />
          </ContentSection>
        </MainContent>
      }
    />
  );
}

/**
 * Usage in TeacherDashboard:
 * -------------------------
 */
// In TeacherDashboard.js
import ActivityLog from './ActivityLog';

export default function TeacherDashboard() {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const loggedInUser = JSON.parse(localStorage.getItem('loggedInUser'));
    setUser(loggedInUser);
    setLoading(false);
  }, []);

  return (
    <DashboardContainer
      sidebar={/* sidebar */}
      main={
        <MainContent>
          {/* ... other content ... */}

          <ContentSection title="Student Activity Monitor">
            <ActivityLog 
              role="teacher" 
              userId={user?.id}
              limit={50}
            />
          </ContentSection>
        </MainContent>
      }
    />
  );
}

/**
 * API ENDPOINTS
 * 
 * GET /api/activity-logs
 * ----------------------
 * Fetches activity logs with optional filtering
 * 
 * Query Parameters:
 * - limit: number of records (default: 50, max: 500)
 * - offset: pagination offset (default: 0)
 * - teacher_id: filter by teacher's assigned students
 * - grade_level: filter by grade (e.g., 'Grade 5')
 * - section: filter by section (e.g., 'Section A')
 * - search: search by student name
 * - sort_by: field to sort by (default: activity_timestamp)
 * - sort_order: ASC or DESC (default: DESC)
 * 
 * Example URLs:
 * http://localhost:5000/api/activity-logs?limit=50&grade_level=Grade%205
 * http://localhost:5000/api/activity-logs?teacher_id=3&search=Juan
 * http://localhost:5000/api/activity-logs?grade_level=Grade%204&section=Section%20A
 * 
 * Response Format:
 * {
 *   "data": [
 *     {
 *       "id": 1,
 *       "student_id": 123,
 *       "student_name": "Juan Dela Cruz",
 *       "grade_level": "Grade 5",
 *       "section": "Section A",
 *       "current_quest": "Forest Gatekeeper",
 *       "save_status": "saved",
 *       "total_play_time": 2700,
 *       "last_played": "2024-05-09T10:30:00Z",
 *       "quest_progress": 85,
 *       "difficulty_level": "Normal",
 *       "activity_timestamp": "2024-05-09T10:30:00Z",
 *       ...
 *     }
 *   ],
 *   "pagination": {
 *     "total": 150,
 *     "limit": 50,
 *     "offset": 0,
 *     "pages": 3,
 *     "current_page": 1
 *   }
 * }
 * 
 * POST /api/activity-logs
 * ----------------------
 * Creates a new activity log entry
 * 
 * Request Body:
 * {
 *   "student_id": 123,
 *   "student_name": "Juan Dela Cruz",
 *   "grade_level": "Grade 5",
 *   "section": "Section A",
 *   "current_quest": "Forest Gatekeeper",
 *   "save_status": "saved",
 *   "total_play_time": 2700,
 *   "quest_progress": 85,
 *   "difficulty_level": "Normal",
 *   "role": "Student",
 *   "status": "Online",
 *   "activity_description": "Completed Forest Gatekeeper Quest"
 * }
 */

/**
 * FEATURES PROVIDED
 * 
 * ✓ Search by student name with debouncing
 * ✓ Filter by grade level
 * ✓ Filter by section (dynamic based on grade)
 * ✓ Combined filtering (grade + section + search)
 * ✓ Role-based access (Admin sees all, Teachers see their students only)
 * ✓ Gameplay tracking (quest, progress, playtime, save status)
 * ✓ Professional table design with responsive layout
 * ✓ Pagination with configurable page size
 * ✓ Sticky table headers
 * ✓ Hover effects and visual feedback
 * ✓ Mobile-optimized responsive behavior
 * ✓ Performance optimized with memoization
 * ✓ Accessibility features
 * 
 * GAMEPLAY TRACKING COLUMNS
 * 
 * - Student Name: Full name of the student
 * - Grade Level: Grade with color-coded badge
 * - Section: Class section
 * - Current Quest: Active quest or game
 * - Save Status: Saved, Pending, or Completed with visual indicators
 * - Total Play Time: Formatted hours and minutes
 * - Last Played: Time of last session
 * - Quest Progress: Visual progress bar with percentage
 * - Difficulty Level: Color-coded difficulty (Easy, Normal, Hard, Expert)
 * - Activity Timestamp: Date and time of record
 * 
 * MOBILE RESPONSIVE BEHAVIOR
 * 
 * Desktop (1440px+):
 *   - Show all columns
 *   - Full filter row
 *   - Large pagination buttons
 * 
 * Tablet (768px - 1023px):
 *   - Hide: Section, Difficulty, Timestamp
 *   - Stack filters vertically
 *   - Compact pagination
 * 
 * Mobile (< 768px):
 *   - Show only: Student Name, Grade Level
 *   - Single column filters
 *   - Essential information visible
 *   - Horizontal scroll for table
 * 
 * PERFORMANCE OPTIMIZATIONS
 * 
 * - Debounced search (300ms) to reduce API calls
 * - Memoized filtered results to prevent unnecessary re-renders
 * - Lazy pagination to load data on demand
 * - Optimized table rendering
 * - Sticky headers for better UX
 * - Efficient filter state management
 */
