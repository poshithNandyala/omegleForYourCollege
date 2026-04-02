#!/usr/bin/env python3
"""
CampusLink Backend API Testing Suite
Tests all backend endpoints for functionality and integration
"""

import requests
import sys
import json
import time
from datetime import datetime

class CampusLinkAPITester:
    def __init__(self, base_url="http://localhost:8001"):
        self.base_url = base_url
        self.token = None
        self.tests_run = 0
        self.tests_passed = 0
        self.failed_tests = []
        self.session = requests.Session()
        self.session.headers.update({'Content-Type': 'application/json'})

    def log_result(self, test_name, success, response_data=None, error_msg=None):
        """Log test results"""
        self.tests_run += 1
        if success:
            self.tests_passed += 1
            print(f"✅ {test_name} - PASSED")
        else:
            print(f"❌ {test_name} - FAILED: {error_msg}")
            self.failed_tests.append({
                "test": test_name,
                "error": error_msg,
                "response": response_data
            })

    def run_test(self, name, method, endpoint, expected_status, data=None, headers=None):
        """Run a single API test"""
        url = f"{self.base_url}/{endpoint}"
        test_headers = self.session.headers.copy()
        if headers:
            test_headers.update(headers)
        if self.token:
            test_headers['Authorization'] = f'Bearer {self.token}'

        print(f"\n🔍 Testing {name}...")
        print(f"   URL: {method} {url}")
        
        try:
            if method == 'GET':
                response = self.session.get(url, headers=test_headers)
            elif method == 'POST':
                response = self.session.post(url, json=data, headers=test_headers)
            elif method == 'PUT':
                response = self.session.put(url, json=data, headers=test_headers)
            elif method == 'DELETE':
                response = self.session.delete(url, headers=test_headers)

            print(f"   Status: {response.status_code}")
            
            success = response.status_code == expected_status
            response_data = {}
            
            try:
                response_data = response.json()
                if success:
                    print(f"   Response: {json.dumps(response_data, indent=2)[:200]}...")
            except:
                response_data = {"text": response.text[:200]}

            if success:
                self.log_result(name, True, response_data)
                return True, response_data
            else:
                error_msg = f"Expected {expected_status}, got {response.status_code}"
                if response_data:
                    error_msg += f" - {response_data.get('detail', response_data)}"
                self.log_result(name, False, response_data, error_msg)
                return False, response_data

        except Exception as e:
            error_msg = f"Request failed: {str(e)}"
            self.log_result(name, False, None, error_msg)
            return False, {}

    def test_health_endpoint(self):
        """Test health check endpoint"""
        return self.run_test("Health Check", "GET", "api/health", 200)

    def test_stats_endpoint(self):
        """Test stats endpoint"""
        return self.run_test("Platform Stats", "GET", "api/stats", 200)

    def test_send_otp_invalid_email(self):
        """Test OTP sending with invalid email (should reject non-college emails)"""
        invalid_emails = [
            "test@gmail.com",
            "user@yahoo.com", 
            "student@company.com"
        ]
        
        for email in invalid_emails:
            success, _ = self.run_test(
                f"Send OTP - Invalid Email ({email})",
                "POST",
                "api/auth/send-otp",
                400,
                {"email": email}
            )
            if success:
                print(f"   ✅ Correctly rejected non-college email: {email}")
            else:
                print(f"   ❌ Should have rejected non-college email: {email}")

    def test_send_otp_valid_email(self):
        """Test OTP sending with valid college email"""
        valid_emails = [
            "test@iitb.ac.in",
            "student@college.ac.in",
            "user@test.edu.in"
        ]
        
        for email in valid_emails:
            success, response = self.run_test(
                f"Send OTP - Valid Email ({email})",
                "POST", 
                "api/auth/send-otp",
                200,
                {"email": email}
            )
            if success and response.get("status") == "success":
                print(f"   ✅ Successfully sent OTP to: {email}")
                return email  # Return first successful email for further testing
            
        return None

    def test_admin_login(self):
        """Test admin login with provided credentials"""
        admin_email = "admin@campuslink.com"
        admin_password = "CampusLink@2024"
        
        success, response = self.run_test(
            "Admin Login",
            "POST",
            "api/auth/login", 
            200,
            {"email": admin_email, "password": admin_password}
        )
        
        if success and response.get("access_token"):
            self.token = response["access_token"]
            print(f"   ✅ Admin login successful, token acquired")
            return True
        else:
            print(f"   ❌ Admin login failed")
            return False

    def test_get_current_user(self):
        """Test getting current user with token"""
        if not self.token:
            self.log_result("Get Current User", False, None, "No token available")
            return False
            
        return self.run_test("Get Current User", "GET", "api/auth/me", 200)

    def test_friends_endpoint(self):
        """Test friends endpoint"""
        if not self.token:
            self.log_result("Get Friends", False, None, "No token available")
            return False
            
        return self.run_test("Get Friends List", "GET", "api/friends", 200)

    def test_call_history_endpoint(self):
        """Test call history endpoint"""
        if not self.token:
            self.log_result("Get Call History", False, None, "No token available")
            return False
            
        return self.run_test("Get Call History", "GET", "api/calls/history", 200)

    def test_match_find_endpoint(self):
        """Test match finding endpoint"""
        if not self.token:
            self.log_result("Find Match", False, None, "No token available")
            return False
            
        # Test different connection modes
        modes = ["same_college", "same_wifi", "cross_college"]
        
        for mode in modes:
            success, response = self.run_test(
                f"Find Match - {mode}",
                "POST",
                "api/match/find",
                200,
                {"mode": mode}
            )
            
            if success:
                status = response.get("status")
                if status in ["matched", "waiting"]:
                    print(f"   ✅ Match endpoint working for {mode}: {status}")
                else:
                    print(f"   ⚠️  Unexpected status for {mode}: {status}")

    def test_invalid_endpoints(self):
        """Test some invalid endpoints to ensure proper error handling"""
        invalid_tests = [
            ("Invalid Endpoint", "GET", "api/nonexistent", 404),
            ("Invalid Auth Endpoint", "GET", "api/auth/invalid", 404),
        ]
        
        for name, method, endpoint, expected_status in invalid_tests:
            self.run_test(name, method, endpoint, expected_status)

    def test_brute_force_protection(self):
        """Test brute force protection on login"""
        print("\n🔍 Testing Brute Force Protection...")
        
        # Try multiple failed logins
        for i in range(3):
            success, response = self.run_test(
                f"Failed Login Attempt {i+1}",
                "POST",
                "api/auth/login",
                401,
                {"email": "admin@campuslink.com", "password": "wrongpassword"}
            )
            time.sleep(0.5)  # Small delay between attempts

    def run_all_tests(self):
        """Run all backend tests"""
        print("=" * 60)
        print("🚀 CAMPUSLINK BACKEND API TESTING")
        print("=" * 60)
        
        # Basic health checks
        print("\n📊 BASIC HEALTH CHECKS")
        self.test_health_endpoint()
        self.test_stats_endpoint()
        
        # Authentication tests
        print("\n🔐 AUTHENTICATION TESTS")
        self.test_send_otp_invalid_email()
        valid_email = self.test_send_otp_valid_email()
        admin_login_success = self.test_admin_login()
        
        if admin_login_success:
            self.test_get_current_user()
        
        # Protected endpoint tests (require authentication)
        print("\n👥 PROTECTED ENDPOINT TESTS")
        self.test_friends_endpoint()
        self.test_call_history_endpoint()
        self.test_match_find_endpoint()
        
        # Security tests
        print("\n🛡️  SECURITY TESTS")
        self.test_brute_force_protection()
        
        # Error handling tests
        print("\n❌ ERROR HANDLING TESTS")
        self.test_invalid_endpoints()
        
        # Print final results
        print("\n" + "=" * 60)
        print("📊 TEST RESULTS SUMMARY")
        print("=" * 60)
        print(f"Total Tests: {self.tests_run}")
        print(f"Passed: {self.tests_passed}")
        print(f"Failed: {len(self.failed_tests)}")
        print(f"Success Rate: {(self.tests_passed/self.tests_run)*100:.1f}%")
        
        if self.failed_tests:
            print("\n❌ FAILED TESTS:")
            for test in self.failed_tests:
                print(f"  - {test['test']}: {test['error']}")
        
        return len(self.failed_tests) == 0

def main():
    """Main test execution"""
    tester = CampusLinkAPITester()
    success = tester.run_all_tests()
    
    # Return appropriate exit code
    return 0 if success else 1

if __name__ == "__main__":
    sys.exit(main())