-- phpMyAdmin SQL Dump
-- version 5.2.1
-- https://www.phpmyadmin.net/
--
-- Host: 127.0.0.1
-- Generation Time: Jan 27, 2026 at 04:01 PM
-- Server version: 10.4.32-MariaDB
-- PHP Version: 8.2.12

SET SQL_MODE = "NO_AUTO_VALUE_ON_ZERO";
START TRANSACTION;
SET time_zone = "+00:00";


/*!40101 SET @OLD_CHARACTER_SET_CLIENT=@@CHARACTER_SET_CLIENT */;
/*!40101 SET @OLD_CHARACTER_SET_RESULTS=@@CHARACTER_SET_RESULTS */;
/*!40101 SET @OLD_COLLATION_CONNECTION=@@COLLATION_CONNECTION */;
/*!40101 SET NAMES utf8mb4 */;

--
-- Database: `esgdashboard`
--
CREATE DATABASE IF NOT EXISTS `esgdashboard`
  DEFAULT CHARACTER SET utf8mb4
  COLLATE utf8mb4_general_ci;

USE `esgdashboard`;

-- --------------------------------------------------------

--
-- Table structure for table `accounts`
--

CREATE TABLE `accounts` (
  `id` int(11) NOT NULL,
  `account` varchar(255) NOT NULL,
  `password` varchar(255) NOT NULL,
  `dashboard_mode` varchar(45) NOT NULL DEFAULT 'auto'
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

--
-- Dumping data for table `accounts`
--

INSERT INTO `accounts` (`id`, `account`, `password`, `dashboard_mode`) VALUES
(1, 'Admin', '$2b$10$q6bA2pw83gqxHECiy3y6Ru5j0Q1HAk0l5og14LTbKxzSC3.pAG8pO', 'auto');

-- --------------------------------------------------------

--
-- Table structure for table `assistant_questions`
--

CREATE TABLE `assistant_questions` (
  `id` int(11) NOT NULL,
  `account_id` int(11) NOT NULL,
  `question` text NOT NULL,
  `asked_at` datetime NOT NULL DEFAULT current_timestamp()
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- --------------------------------------------------------

--
-- Table structure for table `building_ebills`
--

CREATE TABLE `building_ebills` (
  `id` int(11) NOT NULL,
  `account_id` int(11) NOT NULL,
  `building_name` varchar(50) NOT NULL,
  `bill_month` date NOT NULL,
  `bill_amount` decimal(10,2) NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- --------------------------------------------------------

--
-- Table structure for table `building_info`
--

CREATE TABLE `building_info` (
  `id` int(11) NOT NULL,
  `account_id` int(11) NOT NULL,
  `building_name` varchar(50) NOT NULL,
  `desc` text NOT NULL,
  `filename` varchar(255) DEFAULT NULL,
  `display_label` varchar(255) DEFAULT NULL,
  `card_label` varchar(255) DEFAULT NULL,
  `elec_startyear` int(11) DEFAULT NULL,
  `elec_endyear` int(11) DEFAULT NULL,
  `water_startyear` int(11) DEFAULT NULL,
  `water_endyear` int(11) DEFAULT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

--
-- Dumping data for table `building_info`
--

INSERT INTO `building_info` (`id`, `account_id`, `building_name`, `desc`, `filename`, `display_label`, `card_label`, `elec_startyear`, `elec_endyear`, `water_startyear`, `water_endyear`) VALUES
(177, 1, 'ECMC', 'test', '1769276531261-ecmc.jpg', 'ECMC - Energy Centre Multi-Story Carpark', 'ECMC', NULL, NULL, NULL, NULL),
(178, 1, 'RPC', 'test', '1769276710566-RPC.png', 'RPC - Republic Polytechnic Centre', 'RPC', NULL, NULL, NULL, NULL),
(179, 1, 'TRCC', 'test', '1769276613642-trcc.jpg', 'TRCC - The Republic Cultural Centre', 'TRCC', NULL, NULL, NULL, NULL),
(180, 1, 'E1', 'Test 4', '1769276492917-E1.jpg', 'E1 - Centre of Educational Development', 'E1 - CED', NULL, NULL, NULL, NULL),
(181, 1, 'E2', 'test', '1769255441788-E2.jpg', 'E2 - School of Technology of Arts', 'E2 - STA', NULL, NULL, NULL, NULL),
(182, 1, 'E3', 'test', '1769276500796-E3.jpg', 'E3 - School of Business', 'E3 - SBZ', NULL, NULL, NULL, NULL),
(183, 1, 'E4', 'test', '1769276512931-E4.jpg', 'E4 - School of Business', 'E4 - SBZ', NULL, NULL, NULL, NULL),
(184, 1, 'E5', 'test', '1769276519031-E5.jpg', 'E5 - School of Sports & Health', 'E5 - SSH', NULL, NULL, NULL, NULL),
(185, 1, 'E6', 'test', '1769276525077-E6.jpg', 'E6 - School of Infocomn', 'E6 - SOI', NULL, NULL, NULL, NULL),
(186, 1, 'W1', 'test', '1769276623243-W1.jpg', 'W1 - School of Engineering', 'W1 - SEG', NULL, NULL, NULL, NULL),
(187, 1, 'W2', 'test', '1769276633298-W2.jpg', 'W2 - School of Engineering', 'W2 - SEG', NULL, NULL, NULL, NULL),
(188, 1, 'W3', 'test', '1769276647676-W3.jpg', 'W3 - School of Applied Sciences', 'W3 - SAS', NULL, NULL, NULL, NULL),
(189, 1, 'W4', 'test', '1769276655644-W4.jpg', 'W4 - School of Hospitality', 'W4 - SOH', NULL, NULL, NULL, NULL),
(190, 1, 'W5', 'test', '1769276664829-W5.jpg', 'W5 - School of Applied Sciences', 'W5 - SAS', NULL, NULL, NULL, NULL),
(191, 1, 'W6', 'test', '1769276672745-W6.jpg', 'W6 - School of Infocomn', 'W6 - SOI', NULL, NULL, NULL, NULL),
(192, 1, 'Sports Complex', 'test', '1769276590347-sports-complex.jpg', 'Sports Complex ', 'Sports Complex', NULL, NULL, NULL, NULL),
(193, 1, 'The Arch', 'test', '1769276602128-the-arch.jpg', 'The Arch ', 'The Arch', NULL, NULL, NULL, NULL),
(194, 1, 'Green House', 'test', '1769276544009-green-house.jpg', 'Green House ', 'Green House', NULL, NULL, NULL, NULL),
(195, 1, 'Blk 43', 'test', '1769276487451-blk-43.jpg', 'SIT Building', 'SIT', NULL, NULL, NULL, NULL),
(196, 1, 'RPIC', 'test', '1769276581559-rpic.jpg', 'RPIC - Republic Polytechnic Industry Centre', 'RPIC', NULL, NULL, NULL, NULL),
(197, 1, 'XLC', 'test', '1769276682692-xlc.jpg', 'XLC - Xperiental Learning Centre', 'XLC', NULL, NULL, NULL, NULL),
(198, 1, 'ALC', 'test3', '1769276480981-alc.jpg', 'ALC - Adventure Learning Centre', 'ALC', NULL, NULL, NULL, NULL);

-- --------------------------------------------------------

--
-- Table structure for table `building_waterusage`
--

CREATE TABLE `building_waterusage` (
  `id` int(11) NOT NULL,
  `account_id` int(11) NOT NULL,
  `building_name` varchar(50) NOT NULL,
  `bill_month` date NOT NULL,
  `water_used` decimal(10,2) NOT NULL DEFAULT 0.00
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- --------------------------------------------------------

--
-- Table structure for table `dashboard_media`
--

CREATE TABLE `dashboard_media` (
  `id` int(11) NOT NULL,
  `account_id` int(11) NOT NULL,
  `media_type` enum('image','video') NOT NULL,
  `filename` varchar(255) NOT NULL,
  `sort_order` int(11) NOT NULL DEFAULT 1,
  `is_enabled` tinyint(1) NOT NULL DEFAULT 1,
  `created_at` timestamp NOT NULL DEFAULT current_timestamp()
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

--
-- Dumping data for table `dashboard_media`
--

INSERT INTO `dashboard_media` (`id`, `account_id`, `media_type`, `filename`, `sort_order`, `is_enabled`, `created_at`) VALUES
(26, 1, 'image', '1769332873283-1765602136706-rpGreenHouse01.jpg', 2, 1, '2026-01-25 09:21:13'),
(27, 1, 'video', '1769332891578-1767337617491-An Introduction to Republic Poly.mp4', 2, 1, '2026-01-25 09:21:31'),
(28, 1, 'image', '1769332897536-1765599521609-rpSustainability01.jpg', 1, 1, '2026-01-25 09:21:37'),
(29, 1, 'image', '1769332908079-1765602139970-solarpanels01.jpg', 3, 1, '2026-01-25 09:21:48'),
(30, 1, 'video', '1769332940841-1767337598326-Republic Polytechnic - Work Study Programme.mp4', 1, 1, '2026-01-25 09:22:20');

-- --------------------------------------------------------

--
-- Table structure for table `timers`
--

CREATE TABLE `timers` (
  `timer_id` int(11) NOT NULL,
  `account_id` int(11) NOT NULL DEFAULT 1,
  `page_number` int(11) NOT NULL,
  `page_name` varchar(100) NOT NULL,
  `duration_seconds` int(11) NOT NULL DEFAULT 15,
  `background_animation` varchar(20) NOT NULL DEFAULT 'particles'
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

--
-- Dumping data for table `timers`
--

INSERT INTO `timers` (`timer_id`, `account_id`, `page_number`, `page_name`, `duration_seconds`, `background_animation`) VALUES
(1, 1, 1, 'Welcome / Intro', 3, 'rain'),
(2, 1, 2, 'Campus Overview', 30, 'particles'),
(3, 1, 3, 'Electricity Usage', 30, 'sparks'),
(4, 1, 4, 'Water Usage', 30, 'particles'),
(5, 1, 5, 'Building Comparison', 30, 'particles'),
(6, 1, 6, 'Solar Energy', 30, 'particles'),
(7, 1, 7, 'Waste Management', 30, 'particles'),
(8, 1, 8, 'Media / Video Playback', 1, 'particles'),
(9, 1, 9, 'Sustainability Highlights', 15, 'particles'),
(10, 1, 10, 'Thank You / Loop Restart', 5, 'particles'),
(11, 1, 11, 'Campus Analytics', 75, 'particles');

-- --------------------------------------------------------

--
-- Table structure for table `total_ebills`
--

CREATE TABLE `total_ebills` (
  `id` int(11) NOT NULL,
  `account_id` int(11) NOT NULL,
  `bill_month` date NOT NULL,
  `total_bill` decimal(10,2) NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- --------------------------------------------------------

--
-- Table structure for table `total_solardata`
--

CREATE TABLE `total_solardata` (
  `id` int(11) NOT NULL,
  `account_id` int(11) NOT NULL,
  `bill_month` date NOT NULL,
  `urban_renewables` decimal(10,2) NOT NULL,
  `green_house` decimal(10,2) NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- --------------------------------------------------------

--
-- Table structure for table `total_wastedata`
--

CREATE TABLE `total_wastedata` (
  `id` int(11) NOT NULL,
  `account_id` int(11) NOT NULL,
  `bill_month` date NOT NULL,
  `general_kg` decimal(10,2) NOT NULL,
  `recyclable_kg` decimal(10,2) NOT NULL,
  `general_percent` decimal(5,2) NOT NULL,
  `recyclable_percent` decimal(5,2) NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- --------------------------------------------------------

--
-- Table structure for table `total_waterusage`
--

CREATE TABLE `total_waterusage` (
  `id` int(11) NOT NULL,
  `account_id` int(11) NOT NULL,
  `bill_month` date NOT NULL,
  `portable_water` decimal(10,2) NOT NULL,
  `recycled_water` decimal(10,2) NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- --------------------------------------------------------

--
-- Table structure for table `year_range`
--

CREATE TABLE `year_range` (
  `id` int(11) NOT NULL,
  `account_id` int(11) NOT NULL,
  `year` int(11) NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

--
-- Indexes for dumped tables
--

--
-- Indexes for table `accounts`
--
ALTER TABLE `accounts`
  ADD PRIMARY KEY (`id`);

--
-- Indexes for table `assistant_questions`
--
ALTER TABLE `assistant_questions`
  ADD PRIMARY KEY (`id`),
  ADD KEY `account_id` (`account_id`),
  ADD KEY `asked_at` (`asked_at`);

--
-- Indexes for table `building_ebills`
--
ALTER TABLE `building_ebills`
  ADD PRIMARY KEY (`id`),
  ADD KEY `account_id` (`account_id`);

--
-- Indexes for table `building_info`
--
ALTER TABLE `building_info`
  ADD PRIMARY KEY (`id`),
  ADD KEY `account_id` (`account_id`);

--
-- Indexes for table `building_waterusage`
--
ALTER TABLE `building_waterusage`
  ADD PRIMARY KEY (`id`),
  ADD KEY `account_id` (`account_id`);

--
-- Indexes for table `dashboard_media`
--
ALTER TABLE `dashboard_media`
  ADD PRIMARY KEY (`id`),
  ADD KEY `dashboard_media_ibfk_1` (`account_id`);

--
-- Indexes for table `timers`
--
ALTER TABLE `timers`
  ADD PRIMARY KEY (`timer_id`),
  ADD UNIQUE KEY `page_number` (`page_number`),
  ADD UNIQUE KEY `unique_account_page` (`account_id`,`page_number`);

--
-- Indexes for table `total_ebills`
--
ALTER TABLE `total_ebills`
  ADD PRIMARY KEY (`id`),
  ADD KEY `account_id` (`account_id`);

--
-- Indexes for table `total_solardata`
--
ALTER TABLE `total_solardata`
  ADD PRIMARY KEY (`id`),
  ADD KEY `account_id` (`account_id`);

--
-- Indexes for table `total_wastedata`
--
ALTER TABLE `total_wastedata`
  ADD PRIMARY KEY (`id`),
  ADD KEY `account_id` (`account_id`);

--
-- Indexes for table `total_waterusage`
--
ALTER TABLE `total_waterusage`
  ADD PRIMARY KEY (`id`),
  ADD KEY `account_id` (`account_id`);

--
-- Indexes for table `year_range`
--
ALTER TABLE `year_range`
  ADD PRIMARY KEY (`id`),
  ADD KEY `account_id` (`account_id`);

--
-- AUTO_INCREMENT for dumped tables
--

--
-- AUTO_INCREMENT for table `accounts`
--
ALTER TABLE `accounts`
  MODIFY `id` int(11) NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=2;

--
-- AUTO_INCREMENT for table `assistant_questions`
--
ALTER TABLE `assistant_questions`
  MODIFY `id` int(11) NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=1;

--
-- AUTO_INCREMENT for table `building_ebills`
--
ALTER TABLE `building_ebills`
  MODIFY `id` int(11) NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=68641;

--
-- AUTO_INCREMENT for table `building_info`
--
ALTER TABLE `building_info`
  MODIFY `id` int(11) NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=199;

--
-- AUTO_INCREMENT for table `building_waterusage`
--
ALTER TABLE `building_waterusage`
  MODIFY `id` int(11) NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=43681;

--
-- AUTO_INCREMENT for table `dashboard_media`
--
ALTER TABLE `dashboard_media`
  MODIFY `id` int(11) NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=31;

--
-- AUTO_INCREMENT for table `timers`
--
ALTER TABLE `timers`
  MODIFY `timer_id` int(11) NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=12;

--
-- AUTO_INCREMENT for table `total_ebills`
--
ALTER TABLE `total_ebills`
  MODIFY `id` int(11) NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=3121;

--
-- AUTO_INCREMENT for table `total_solardata`
--
ALTER TABLE `total_solardata`
  MODIFY `id` int(11) NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=3121;

--
-- AUTO_INCREMENT for table `total_wastedata`
--
ALTER TABLE `total_wastedata`
  MODIFY `id` int(11) NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=3100;

--
-- AUTO_INCREMENT for table `total_waterusage`
--
ALTER TABLE `total_waterusage`
  MODIFY `id` int(11) NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=3057;

--
-- AUTO_INCREMENT for table `year_range`
--
ALTER TABLE `year_range`
  MODIFY `id` int(11) NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=198;

--
-- Constraints for dumped tables
--

--
-- Constraints for table `building_ebills`
--
ALTER TABLE `building_ebills`
  ADD CONSTRAINT `building_ebills_ibfk_1` FOREIGN KEY (`account_id`) REFERENCES `accounts` (`id`);

--
-- Constraints for table `building_info`
--
ALTER TABLE `building_info`
  ADD CONSTRAINT `building_info_ibfk_1` FOREIGN KEY (`account_id`) REFERENCES `accounts` (`id`);

--
-- Constraints for table `building_waterusage`
--
ALTER TABLE `building_waterusage`
  ADD CONSTRAINT `building_waterusage_ibfk_1` FOREIGN KEY (`account_id`) REFERENCES `accounts` (`id`);

--
-- Constraints for table `dashboard_media`
--
ALTER TABLE `dashboard_media`
  ADD CONSTRAINT `dashboard_media_ibfk_1` FOREIGN KEY (`account_id`) REFERENCES `accounts` (`id`);

--
-- Constraints for table `timers`
--
ALTER TABLE `timers`
  ADD CONSTRAINT `fk_timers_account` FOREIGN KEY (`account_id`) REFERENCES `accounts` (`id`) ON DELETE CASCADE;

--
-- Constraints for table `total_ebills`
--
ALTER TABLE `total_ebills`
  ADD CONSTRAINT `total_ebills_ibfk_1` FOREIGN KEY (`account_id`) REFERENCES `accounts` (`id`);

--
-- Constraints for table `total_solardata`
--
ALTER TABLE `total_solardata`
  ADD CONSTRAINT `total_solardata_ibfk_1` FOREIGN KEY (`account_id`) REFERENCES `accounts` (`id`);

--
-- Constraints for table `total_wastedata`
--
ALTER TABLE `total_wastedata`
  ADD CONSTRAINT `total_wastedata_ibfk_1` FOREIGN KEY (`account_id`) REFERENCES `accounts` (`id`);

--
-- Constraints for table `total_waterusage`
--
ALTER TABLE `total_waterusage`
  ADD CONSTRAINT `total_waterusage_ibfk_1` FOREIGN KEY (`account_id`) REFERENCES `accounts` (`id`);

--
-- Constraints for table `year_range`
--
ALTER TABLE `year_range`
  ADD CONSTRAINT `year_range_ibfk_1` FOREIGN KEY (`account_id`) REFERENCES `accounts` (`id`) ON DELETE CASCADE;
COMMIT;

/*!40101 SET CHARACTER_SET_CLIENT=@OLD_CHARACTER_SET_CLIENT */;
/*!40101 SET CHARACTER_SET_RESULTS=@OLD_CHARACTER_SET_RESULTS */;
/*!40101 SET COLLATION_CONNECTION=@OLD_COLLATION_CONNECTION */;
